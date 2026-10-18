import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { PAYMENT_TYPES, VOUCHER_TYPES, type ProofItem } from "@offline-pay/shared";
import { FakeChain } from "../src/chain/fake.js";
import { REDEEM_STATUS } from "../src/chain/types.js";
import { testEnv, TEST_ISSUER_KEY } from "./helpers.js";

const issuer = privateKeyToAccount(TEST_ISSUER_KEY);
const device = privateKeyToAccount(`0x${"3".repeat(64)}`);
const secondDevice = privateKeyToAccount(`0x${"4".repeat(64)}`);
const payee = "0x0000000000000000000000000000000000000500" as Address;
const domain = { name: "OfflineVault", version: "1", chainId: testEnv.CHAIN_ID, verifyingContract: testEnv.VAULT_ADDRESS as Address };

async function makeItem(options: { deviceAddress?: Address; expiry?: bigint; deadline?: bigint; usdcAmount?: bigint } = {}): Promise<ProofItem> {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const signer = options.deviceAddress === secondDevice.address ? secondDevice : device;
  const voucher = {
    voucherId: `0x${randomBytes(32).toString("hex")}` as Hex,
    device: options.deviceAddress ?? device.address,
    usdcAmount: options.usdcAmount ?? 100n,
    inrPaise: 100,
    expiry: options.expiry ?? now + 600n,
  };
  const payment = {
    voucherId: voucher.voucherId,
    device: voucher.device,
    payee,
    usdcAmount: voucher.usdcAmount,
    deadline: options.deadline ?? now + 600n,
  };
  const issuerSig = await issuer.signTypedData({ domain, types: VOUCHER_TYPES, primaryType: "Voucher", message: voucher });
  const deviceSig = await signer.signTypedData({ domain, types: PAYMENT_TYPES, primaryType: "Payment", message: payment });
  return { voucher, issuerSig, payment, deviceSig };
}

describe("FakeChain redeem status simulation", () => {
  it("returns each status code specified for redeemBatch", async () => {
    const chain = new FakeChain({ chainId: testEnv.CHAIN_ID, vaultAddress: testEnv.VAULT_ADDRESS as Address, issuerAddress: issuer.address });
    await chain.fundCollateral(device.address, 100n);

    const valid = await makeItem();
    expect((await chain.redeemBatch([valid]))[0]?.status).toBe(REDEEM_STATUS.OK);
    expect((await chain.redeemBatch([valid]))[0]?.status).toBe(REDEEM_STATUS.ALREADY_REDEEMED);

    const invalidIssuer = await makeItem();
    invalidIssuer.issuerSig = `0x${"00".repeat(65)}` as Hex;
    expect((await chain.redeemBatch([invalidIssuer]))[0]?.status).toBe(REDEEM_STATUS.BAD_ISSUER_SIG);

    const invalidDevice = await makeItem();
    invalidDevice.deviceSig = `0x${"00".repeat(65)}` as Hex;
    expect((await chain.redeemBatch([invalidDevice]))[0]?.status).toBe(REDEEM_STATUS.BAD_DEVICE_SIG);

    const expired = await makeItem({ expiry: BigInt(Math.floor(Date.now() / 1000) - 10) });
    expect((await chain.redeemBatch([expired]))[0]?.status).toBe(REDEEM_STATUS.VOUCHER_EXPIRED);

    const deadlinePassed = await makeItem({ deadline: BigInt(Math.floor(Date.now() / 1000) - 10) });
    expect((await chain.redeemBatch([deadlinePassed]))[0]?.status).toBe(REDEEM_STATUS.DEADLINE_PASSED);

    const frozen = await makeItem();
    await chain.freeze(device.address);
    expect((await chain.redeemBatch([frozen]))[0]?.status).toBe(REDEEM_STATUS.DEVICE_FROZEN);

    const unfundedDeviceItem = await makeItem({ deviceAddress: secondDevice.address });
    expect((await chain.redeemBatch([unfundedDeviceItem]))[0]?.status).toBe(REDEEM_STATUS.INSUFFICIENT_COLLATERAL);

    const mismatch = await makeItem();
    mismatch.payment.voucherId = `0x${"ff".repeat(32)}` as Hex;
    expect((await chain.redeemBatch([mismatch]))[0]?.status).toBe(REDEEM_STATUS.FIELD_MISMATCH);
  });
});
