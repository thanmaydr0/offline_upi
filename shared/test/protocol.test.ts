import { describe, expect, it } from "vitest";
import { getAddress, hashTypedData, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { decodePayload, encodePayload, reassembleFrames, splitFrames, verifyProof } from "../src/index.js";
import { PAYMENT_TYPES, VOUCHER_TYPES } from "../src/typedData.js";
import type { Payment, PaymentProof, VerificationContext, Voucher } from "../src/types.js";

const issuer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const device = privateKeyToAccount("0x8b3a350cf5c34c9194ca3a545d8b6b40e4c7b2d2e2a0e6b4a3f5f5d1b52e3f6a");
const payee = privateKeyToAccount("0x0f4d6c5b8f6d9a09a0a0f8f64292d2f4d3c3a2b1e7b6c5d4a3928170615f4e3d");
const domain = { name: "OfflineVault" as const, version: "1" as const, chainId: 84532, verifyingContract: getAddress("0x0000000000000000000000000000000000008453") };

async function makeProof(overrides: { amount?: bigint; payeeAddress?: Address; expiry?: bigint; deadline?: bigint; issuerAccount?: typeof issuer; deviceAccount?: typeof device; chainId?: number; count?: number } = {}): Promise<PaymentProof> {
  const count = overrides.count ?? 1;
  const items = [];
  for (let index = 0; index < count; index += 1) {
    const voucher: Voucher = { voucherId: `0x${index.toString(16).padStart(64, "0")}` as Hex, device: device.address, usdcAmount: overrides.amount ?? 1_000_000n, inrPaise: 100, expiry: overrides.expiry ?? 2_000_000_000n };
    const payment: Payment = { voucherId: voucher.voucherId, device: voucher.device, payee: overrides.payeeAddress ?? payee.address, usdcAmount: overrides.amount ?? 1_000_000n, deadline: overrides.deadline ?? 2_000_000_000n };
    const itemDomain = { ...domain, chainId: overrides.chainId ?? domain.chainId };
    items.push({ voucher, issuerSig: await (overrides.issuerAccount ?? issuer).signTypedData({ domain: itemDomain, types: VOUCHER_TYPES, primaryType: "Voucher", message: voucher }), payment, deviceSig: await (overrides.deviceAccount ?? device).signTypedData({ domain: itemDomain, types: PAYMENT_TYPES, primaryType: "Payment", message: payment }) });
  }
  return { v: 1, reqId: `0x${"ab".repeat(16)}` as Hex, items };
}

function context(proof: PaymentProof): VerificationContext {
  return { domain, issuerAddress: issuer.address, payeeAddress: payee.address, request: { v: 1, payee: payee.address, inrPaise: proof.items.reduce((sum, item) => sum + item.voucher.inrPaise, 0), reqId: proof.reqId, chainId: domain.chainId, ts: 1_900_000_000 }, nowSeconds: 1_900_000_000n, clockSkewSeconds: 0n, revokedDevices: new Set(), seenVoucherIds: new Set(), maxSinglePaymentPaise: 200_000n, maxUnsettledPaise: 1_000_000n, pendingUnsettledPaise: 0n };
}

describe("QR codec", () => {
  it("round trips deterministic CBOR values including bigint", () => {
    const value = { amount: 9007199254740993n, label: "OfflinePay", bytes: new Uint8Array([1, 2, 3]) };
    const encoded = encodePayload(value);
    expect(encoded).toBe(encodePayload(value));
    const decoded = decodePayload<typeof value>(encoded);
    expect(decoded.amount).toBe(value.amount);
    expect(decoded.label).toBe(value.label);
    expect([...decoded.bytes]).toEqual([1, 2, 3]);
  });

  it("reassembles out of order and reports oversize payloads as frames", () => {
    const encoded = encodePayload({ data: "x".repeat(5000) });
    const frames = splitFrames(encoded, 240);
    expect(frames.length).toBeGreaterThan(1);
    expect(frames.every((frame) => frame.length <= 240)).toBe(true);
    expect(reassembleFrames([...frames].reverse())).toBe(encoded);
  });
});

describe("offline proof verification", () => {
  it("accepts a valid proof", async () => {
    const proof = await makeProof();
    expect(await verifyProof(proof, context(proof))).toMatchObject({ ok: true, totalInrPaise: 100n });
  });

  it("rejects tampered amount", async () => {
    const proof = await makeProof();
    proof.items[0]!.voucher.usdcAmount += 1n;
    expect(await verifyProof(proof, context(proof))).toMatchObject({ ok: false, reason: "invalid_issuer_signature" });
  });

  it("rejects tampered payee", async () => {
    const proof = await makeProof({ payeeAddress: issuer.address });
    expect(await verifyProof(proof, context(proof))).toMatchObject({ ok: false, reason: "wrong_payee" });
  });

  it("rejects wrong issuer", async () => {
    const proof = await makeProof({ issuerAccount: device });
    expect(await verifyProof(proof, context(proof))).toMatchObject({ ok: false, reason: "invalid_issuer_signature" });
  });

  it("rejects wrong device", async () => {
    const proof = await makeProof({ deviceAccount: issuer });
    expect(await verifyProof(proof, context(proof))).toMatchObject({ ok: false, reason: "invalid_device_signature" });
  });

  it("rejects signatures from another chain domain", async () => {
    const proof = await makeProof({ chainId: 8453 });
    expect(await verifyProof(proof, context(proof))).toMatchObject({ ok: false, reason: "invalid_issuer_signature" });
    expect(hashTypedData({ domain, types: VOUCHER_TYPES, primaryType: "Voucher", message: proof.items[0]!.voucher })).not.toBe(hashTypedData({ domain: { ...domain, chainId: 8453 }, types: VOUCHER_TYPES, primaryType: "Voucher", message: proof.items[0]!.voucher }));
  });

  it("rejects expired vouchers and passed deadlines", async () => {
    const expired = await makeProof({ expiry: 1_899_999_999n });
    expect(await verifyProof(expired, context(expired))).toMatchObject({ ok: false, reason: "voucher_expired" });
    const passed = await makeProof({ deadline: 1_899_999_999n });
    expect(await verifyProof(passed, context(passed))).toMatchObject({ ok: false, reason: "payment_deadline_passed" });
  });

  it("rejects duplicate vouchers in the proof and locally seen vouchers", async () => {
    const proof = await makeProof({ count: 2 });
    proof.items[1]!.voucher.voucherId = proof.items[0]!.voucher.voucherId;
    expect(await verifyProof(proof, context(proof))).toMatchObject({ ok: false, reason: "duplicate_voucher" });
    const unique = await makeProof();
    const ctx = { ...context(unique), seenVoucherIds: new Set([unique.items[0]!.voucher.voucherId.toLowerCase()]) };
    expect(await verifyProof(unique, ctx)).toMatchObject({ ok: false, reason: "duplicate_voucher" });
  });
});
