import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import request from "supertest";
import type { Address } from "viem";
import { verifyTypedData } from "viem";
import { PAYMENT_TYPES, VOUCHER_TYPES } from "@offline-pay/shared";
import { privateKeyToAccount } from 'viem/accounts';
import { createApp } from "../src/app.js";
import { createDatabase } from "../src/db/database.js";
import { FakeChain } from "../src/chain/fake.js";
import { OnrampMoneyGateway } from "../src/gateways/fiat.js";
import { createMockPayout } from "../src/services/payouts.js";
import {
  createTestApp,
  registerDevice,
  registrationBody,
  TEST_DEVICE_ADDRESS,
  TEST_DEVICE_KEY,
  TEST_ISSUER_ADDRESS,
  testEnv,
  waitForKycApproval,
  type TestContext,
} from "./helpers.js";

let context: TestContext;

beforeEach(() => { context = createTestApp(); });
afterEach(() => { context.db.close(); });

async function registerAndApprove(deviceAddress: string = TEST_DEVICE_ADDRESS) {
  const auth = await registerDevice(context.app, deviceAddress);
  const bearer = { Authorization: `Bearer ${auth.token}` };
  await request(context.app).post("/v1/kyc/start").set(bearer).expect(202);
  await waitForKycApproval();
  return { ...auth, bearer };
}

async function createOrder(token: string, amountInr: number) {
  const response = await request(context.app).post("/v1/onramp/create").set("Authorization", `Bearer ${token}`).send({ amountInr }).expect(201);
  return response.body as { orderId: string; paymentUrl: string; status: string };
}

function signedEvent(orderId: string, amountInrPaise: number, eventId = randomUUID()) {
  const event = { eventId, orderId, status: "paid" as const, amountInrPaise };
  const signed = context.gateway.signWebhook(event);
  return { event, ...signed };
}

function sendWebhook(_event: unknown, rawBody: Buffer, signature: string) {
  return request(context.app)
    .post("/v1/webhooks/fiat")
    .set("x-fiat-signature", signature)
    .send(rawBody.toString("utf8"))
    .set("content-type", "application/json");
}

async function createFundedOrder(amountInr: number) {
  const auth = await registerAndApprove();
  const order = await createOrder(auth.token, amountInr);
  const { event, rawBody, signature } = signedEvent(order.orderId, amountInr * 100);
  await sendWebhook(event, rawBody, signature).expect(200);
  return { ...auth, order };
}

describe("backend public and account routes", () => {
  it('reuses a durable checkout attempt after a lost response and rejects changed amounts or owners', async () => {
    const auth = await registerAndApprove();
    const attemptId = randomUUID();
    const create = (amountInr: number, token = auth.token) => request(context.app).post('/v1/onramp/create')
      .set('Authorization', `Bearer ${token}`).send({ amountInr, attemptId });
    const first = await create(100).expect(201);
    const again = await create(100).expect(201);
    expect(again.body).toEqual(first.body);
    expect(context.db.prepare('SELECT COUNT(*) FROM orders WHERE id = ?').pluck().get(attemptId)).toBe(1);
    await create(200).expect(409);
    const other = await registerAndApprove('0x0000000000000000000000000000000000000113');
    await create(100, other.token).expect(409);
  });

  it('settles a signed phone payment through the normal app and recovers its payout once', async () => {
    const { token, order } = await createFundedOrder(100);
    const issued = await request(context.app).post('/v1/vouchers/issue').set('Authorization', `Bearer ${token}`)
      .send({ orderId: order.orderId }).expect(201);
    const item = issued.body.vouchers[0] as { voucher: { voucherId: `0x${string}`; device: Address; usdcAmount: string; inrPaise: number; expiry: string }; issuerSig: `0x${string}` };
    const payee = await registerDevice(context.app, '0x0000000000000000000000000000000000000114');
    const bearer = { Authorization: `Bearer ${payee.token}` };
    await request(context.app).post('/v1/payee/vpa').set(bearer).send({ vpa: 'receiver@testbank' }).expect(200);
    const payment = { voucherId: item.voucher.voucherId, device: item.voucher.device,
      payee: '0x0000000000000000000000000000000000000114' as Address,
      usdcAmount: BigInt(item.voucher.usdcAmount), deadline: BigInt(item.voucher.expiry) };
    const deviceSig = await privateKeyToAccount(TEST_DEVICE_KEY).signTypedData({
      domain: { name: 'OfflineVault', version: '1', chainId: testEnv.CHAIN_ID, verifyingContract: testEnv.VAULT_ADDRESS as Address },
      types: PAYMENT_TYPES, primaryType: 'Payment', message: payment,
    });
    const payload = { items: [{ ...item, payment: { ...payment, usdcAmount: payment.usdcAmount.toString(), deadline: payment.deadline.toString() }, deviceSig }] };
    const redeem = vi.spyOn(context.chain, 'redeemBatch').mockRejectedValueOnce(new Error('chain unavailable'));
    await request(context.app).post('/v1/settle').set(bearer).send(payload).expect(500);
    await request(context.app).get('/v1/wallet').set(bearer).expect(200)
      .expect(({ body }) => expect(body.pendingSettlementPaise).toBe(item.voucher.inrPaise));
    expect(context.db.prepare('SELECT status FROM received_items WHERE lower(voucher_id) = ? AND payee_device_id = (SELECT id FROM devices WHERE address = ?)')
      .get(item.voucher.voucherId.toLowerCase(), '0x0000000000000000000000000000000000000114')).toEqual({ status: 'pending' });
    redeem.mockRestore();
    const payout = vi.spyOn(context.gateway, 'createPayout').mockRejectedValueOnce(new Error('Provider temporarily unavailable'));
    const settled = await request(context.app).post('/v1/settle').set(bearer).send(payload).expect(200);
    expect(settled.body.results).toEqual([{ voucherId: item.voucher.voucherId, status: 0 }]);
    expect(context.db.prepare('SELECT status FROM received_items WHERE lower(voucher_id) = ? AND payee_device_id = (SELECT id FROM devices WHERE address = ?)')
      .get(item.voucher.voucherId.toLowerCase(), '0x0000000000000000000000000000000000000114')).toEqual({ status: 'settled' });
    await request(context.app).get(`/v1/settle/${settled.body.settlementId}`).set(bearer).expect(200);
    await request(context.app).get('/v1/payouts').set(bearer).expect(200)
      .expect(({ body }) => expect(body.payouts[0].status).toBe('pending'));
    dbAgePayouts();
    await context.job.run();
    await context.job.run();
    await request(context.app).get('/v1/wallet').set(bearer).expect(200)
      .expect(({ body }) => expect(body.onlineInrPaise).toBe(item.voucher.inrPaise));
    const retry = await request(context.app).post('/v1/settle').set(bearer).send(payload).expect(200);
    expect(retry.body.results).toEqual(settled.body.results);
    expect(context.db.prepare('SELECT COUNT(*) FROM payouts').pluck().get()).toBe(1);
    expect(payout).toHaveBeenCalledTimes(2);
    payout.mockRestore();
    function dbAgePayouts() { context.db.prepare('UPDATE payouts SET created_at = created_at - 2').run(); }
  });
  it("serves config and health with the expected protocol fields", async () => {
    await request(context.app).get("/health").expect(200, { status: "ok" });
    const config = await request(context.app).get("/v1/config").expect(200);
    expect(config.body).toMatchObject({
      issuerAddress: TEST_ISSUER_ADDRESS,
      vaultAddress: testEnv.VAULT_ADDRESS,
      usdcAddress: testEnv.USDC_ADDRESS,
      chainId: testEnv.CHAIN_ID,
      inrPerUsdc: 90,
      denominations: [100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000],
      revokedDevices: [],
    });
    expect(Date.parse(config.body.serverTime as string)).not.toBeNaN();
    expect(config.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("registers a valid physical device and rejects malformed registration bodies", async () => {
    const registration = await request(context.app).post("/v1/devices/register").send(registrationBody()).expect(201);
    expect(registration.body.userId).toEqual(expect.any(String));
    expect(registration.body.token).toEqual(expect.any(String));
    await request(context.app).post("/v1/devices/register").send({ ...registrationBody(), extra: true }).expect(400);
  });

  it("persists integrity flags and rejects rooted and non-device registrations", async () => {
    const rootedAddress = "0x0000000000000000000000000000000000000101";
    await request(context.app).post("/v1/devices/register").send(registrationBody(rootedAddress, { rooted: true, isDevice: true }))
      .expect(403).expect(({ body }) => expect(body.error).toBe("DEVICE_INTEGRITY_FAILED"));
    const emulatorAddress = "0x0000000000000000000000000000000000000102";
    await request(context.app).post("/v1/devices/register").send(registrationBody(emulatorAddress, { rooted: false, isDevice: false })).expect(403);
    expect(context.db.prepare("SELECT rooted, integrity_is_device FROM devices WHERE address = ?").get(rootedAddress) as object)
      .toEqual({ rooted: 1, integrity_is_device: 1 });
    expect(context.db.prepare("SELECT rooted, integrity_is_device FROM devices WHERE address = ?").get(emulatorAddress) as object)
      .toEqual({ rooted: 0, integrity_is_device: 0 });
    const config = await request(context.app).get("/v1/config").expect(200);
    expect(config.body.revokedDevices).toEqual([rootedAddress, emulatorAddress]);
  });

  it("requires bearer auth for account routes and rejects invalid tokens", async () => {
    await request(context.app).get("/v1/wallet").expect(401);
    await request(context.app).get("/v1/wallet").set("Authorization", "Bearer not-a-jwt").expect(401);
  });

  it("starts mock KYC, auto-approves after the delay, and reports missing KYC clearly", async () => {
    const auth = await registerDevice(context.app);
    const bearer = { Authorization: `Bearer ${auth.token}` };
    await request(context.app).get("/v1/kyc/status").set(bearer).expect(404).expect(({ body }) => expect(body.error).toBe("KYC_NOT_STARTED"));
    await request(context.app).post("/v1/kyc/start").set(bearer).expect(202).expect(({ body }) => expect(body.status).toBe("pending"));
    await request(context.app).get("/v1/kyc/status").set(bearer).expect(200).expect(({ body }) => expect(body.status).toBe("pending"));
    await waitForKycApproval();
    await request(context.app).get("/v1/kyc/status").set(bearer).expect(200).expect(({ body }) => expect(body.status).toBe("approved"));
    await request(context.app).post("/v1/kyc/start").set(bearer).expect(200).expect(({ body }) => expect(body.status).toBe("approved"));
  });

  it("creates and scopes onramp orders after KYC, validating rupee inputs", async () => {
    const auth = await registerDevice(context.app);
    const bearer = { Authorization: `Bearer ${auth.token}` };
    await request(context.app).post("/v1/onramp/create").set(bearer).send({ amountInr: 100 }).expect(403).expect(({ body }) => expect(body.error).toBe("KYC_REQUIRED"));
    await request(context.app).post("/v1/kyc/start").set(bearer).expect(202);
    await waitForKycApproval();
    await request(context.app).post("/v1/onramp/create").set(bearer).send({ amountInr: 1.5 }).expect(400);
    await request(context.app).post("/v1/onramp/create").set(bearer).send({ amountInr: 6000 }).expect(400);
    const order = await createOrder(auth.token, 100);
    expect(order).toMatchObject({ paymentUrl: `/mock-upi/${order.orderId}`, status: "pending" });
    await request(context.app).get(`/v1/onramp/${order.orderId}`).set(bearer).expect(200).expect(({ body }) => expect(body.amountInrPaise).toBe(10000));
    await request(context.app).get(`/v1/onramp/${order.orderId}`).expect(401);
    const other = await registerDevice(context.app, "0x0000000000000000000000000000000000000111");
    await request(context.app).get(`/v1/onramp/${order.orderId}`).set("Authorization", `Bearer ${other.token}`).expect(404);
  });

  it("serves mock UPI Pay and Fail controls and funds only a successful payment", async () => {
    const auth = await registerAndApprove();
    const paidOrder = await createOrder(auth.token, 250);
    const page = await request(context.app).get(paidOrder.paymentUrl).expect(200);
    expect(page.headers['content-security-policy']).not.toContain('upgrade-insecure-requests');
    expect(page.text).toContain("Pay");
    expect(page.text).toContain("Fail");
    await request(context.app).post(`${paidOrder.paymentUrl}/action`).type("form").send({ result: "paid" }).expect(200);
    await request(context.app).get(`/v1/onramp/${paidOrder.orderId}`).set(auth.bearer).expect(200).expect(({ body }) => expect(body.status).toBe("funded"));
    const failedOrder = await createOrder(auth.token, 100);
    await request(context.app).post(`${failedOrder.paymentUrl}/action`).type("form").send({ result: "failed" }).expect(200);
    await request(context.app).get(`/v1/onramp/${failedOrder.orderId}`).set(auth.bearer).expect(200).expect(({ body }) => expect(body.status).toBe("failed"));
  });

  it("rejects bad fiat HMACs and treats a replayed signed webhook as idempotent", async () => {
    const auth = await registerAndApprove();
    const order = await createOrder(auth.token, 100);
    const signed = signedEvent(order.orderId, 10000);
    await sendWebhook(signed.event, signed.rawBody, "0".repeat(64)).expect(401);
    await request(context.app).get(`/v1/onramp/${order.orderId}`).set(auth.bearer).expect(200).expect(({ body }) => expect(body.status).toBe("pending"));
    const first = await sendWebhook(signed.event, signed.rawBody, signed.signature).expect(200);
    const collateral = await context.chain.getCollateral(TEST_DEVICE_ADDRESS);
    const second = await sendWebhook(signed.event, signed.rawBody, signed.signature).expect(200);
    expect(first.body).toEqual({ accepted: true, replayed: false });
    expect(second.body).toEqual({ accepted: true, replayed: true });
    expect(await context.chain.getCollateral(TEST_DEVICE_ADDRESS)).toBe(collateral);
    const mismatchedEvent = { ...signed.event, eventId: randomUUID(), amountInrPaise: 1 };
    const mismatchedSigned = context.gateway.signWebhook(mismatchedEvent);
    await sendWebhook(mismatchedEvent, mismatchedSigned.rawBody, mismatchedSigned.signature).expect(400);
  });

  it("issues signed denomination vouchers only once and never above funded collateral", async () => {
    const { token, order } = await createFundedOrder(1000);
    const issued = await request(context.app).post("/v1/vouchers/issue").set("Authorization", `Bearer ${token}`).send({ orderId: order.orderId }).expect(201);
    const vouchers = issued.body.vouchers as { voucher: { voucherId: `0x${string}`; device: `0x${string}`; usdcAmount: string; inrPaise: number; expiry: string }; issuerSig: `0x${string}` }[];
    expect(vouchers.length).toBeGreaterThan(1);
    expect(vouchers.reduce((sum, item) => sum + item.voucher.inrPaise, 0)).toBe(100000);
    const issuedUsdc = vouchers.reduce((sum, item) => sum + BigInt(item.voucher.usdcAmount), 0n);
    expect(issuedUsdc).toBeLessThanOrEqual(await context.chain.getCollateral(TEST_DEVICE_ADDRESS));
    for (const item of vouchers) {
      const valid = await verifyTypedData({
        address: TEST_ISSUER_ADDRESS,
        domain: { name: "OfflineVault", version: "1", chainId: testEnv.CHAIN_ID, verifyingContract: testEnv.VAULT_ADDRESS as Address },
        types: VOUCHER_TYPES,
        primaryType: "Voucher",
        message: { ...item.voucher, usdcAmount: BigInt(item.voucher.usdcAmount), expiry: BigInt(item.voucher.expiry) },
        signature: item.issuerSig,
      });
      expect(valid).toBe(true);
    }
    await request(context.app).post("/v1/vouchers/issue").set("Authorization", `Bearer ${token}`).send({ orderId: order.orderId })
      .expect(201).expect(({ body }) => expect(body.vouchers).toEqual(vouchers));
    expect(context.db.prepare('SELECT COUNT(*) FROM vouchers WHERE order_id = ?').pluck().get(order.orderId)).toBe(vouchers.length);
    const other = await registerDevice(context.app, '0x0000000000000000000000000000000000000112');
    await request(context.app).post('/v1/vouchers/issue').set('Authorization', `Bearer ${other.token}`).send({ orderId: order.orderId }).expect(404);
  });

  it("blocks voucher issuance for a device frozen after a ledger rollback", async () => {
    const { token, order } = await createFundedOrder(100);
    await request(context.app).post("/v1/ledger/head").set("Authorization", `Bearer ${token}`).send({ headHash: `0x${"a".repeat(64)}`, counter: 5 }).expect(200);
    await request(context.app).post("/v1/ledger/head").set("Authorization", `Bearer ${token}`).send({ headHash: `0x${"b".repeat(64)}`, counter: 4 }).expect(409);
    await request(context.app).post("/v1/vouchers/issue").set("Authorization", `Bearer ${token}`).send({ orderId: order.orderId })
      .expect(403).expect(({ body }) => expect(body.error).toBe("DEVICE_FROZEN"));
  });

  it("returns wallet, history, and payouts, stores VPA, and supports mock payout creation", async () => {
    const auth = await registerDevice(context.app);
    const bearer = { Authorization: `Bearer ${auth.token}` };
    await request(context.app).get("/v1/wallet").set(bearer).expect(200).expect(({ body }) => expect(body).toEqual({ onlineInrPaise: 0, offlineIssuedUnspentPaise: 0, pendingSettlementPaise: 0 }));
    await request(context.app).post("/v1/payee/vpa").set(bearer).send({ vpa: "test.user@upi" }).expect(200).expect(({ body }) => expect(body.vpa).toBe("test.user@upi"));
    await request(context.app).post("/v1/payee/vpa").set(bearer).send({ vpa: "invalid" }).expect(400);
    await request(context.app).get("/v1/wallet/history").set(bearer).expect(200).expect(({ body }) => expect(body.items).toEqual([]));
    await request(context.app).get("/v1/payouts").set(bearer).expect(200).expect(({ body }) => expect(body.payouts).toEqual([]));
    const deviceId = context.db.prepare("SELECT id FROM devices WHERE address = ?").pluck().get(TEST_DEVICE_ADDRESS.toLowerCase()) as string;
    const created = await createMockPayout(context.db, context.gateway, { userId: auth.userId, deviceId, amountInrPaise: 5000, vpa: "test.user@upi" });
    expect(created.status).toBe("pending");
    await request(context.app).get("/v1/payouts").set(bearer).expect(200).expect(({ body }) => expect(body.payouts).toHaveLength(1));
    await request(context.app).get("/v1/wallet/history").set(bearer).expect(200).expect(({ body }) => expect(body.items[0].type).toBe("payout"));
  });

  it("accepts monotonic ledger heads and freezes/revokes on counter or hash regression", async () => {
    const auth = await registerDevice(context.app);
    const head = `0x${"a".repeat(64)}`;
    await request(context.app).post("/v1/ledger/head").set("Authorization", `Bearer ${auth.token}`).send({ headHash: head, counter: 5 }).expect(200, { ok: true, flagged: false });
    await request(context.app).post("/v1/ledger/head").set("Authorization", `Bearer ${auth.token}`).send({ headHash: head, counter: 5 }).expect(200);
    await request(context.app).post("/v1/ledger/head").set("Authorization", `Bearer ${auth.token}`).send({ headHash: head, counter: 4 }).expect(409).expect(({ body }) => expect(body.flagged).toBe(true));
    const config = await request(context.app).get("/v1/config").expect(200);
    expect(config.body.revokedDevices).toContain(TEST_DEVICE_ADDRESS.toLowerCase());
    expect(context.db.prepare("SELECT frozen FROM devices WHERE address = ?").pluck().get(TEST_DEVICE_ADDRESS.toLowerCase())).toBe(1);
  });

  it("flags a changed hash at the same ledger counter", async () => {
    const auth = await registerDevice(context.app);
    await request(context.app).post("/v1/ledger/head").set("Authorization", `Bearer ${auth.token}`).send({ headHash: `0x${"c".repeat(64)}`, counter: 8 }).expect(200);
    await request(context.app).post("/v1/ledger/head").set("Authorization", `Bearer ${auth.token}`).send({ headHash: `0x${"d".repeat(64)}`, counter: 8 }).expect(409);
  });
});

describe("live gateway configuration", () => {
  it("blocks checkout without approved live setup and delegates KYC to the provider", async () => {
    const db = createDatabase(":memory:");
    const env = { ...testEnv, FIAT_GATEWAY: "onramp" as const };
    const issuerAddress = TEST_ISSUER_ADDRESS;
    const chain = new FakeChain({ chainId: env.CHAIN_ID, vaultAddress: env.VAULT_ADDRESS as Address, issuerAddress });
    const app = createApp({ env, db, chain, gateway: new OnrampMoneyGateway(), kycApprovalDelayMs: 100 });
    const registration = await request(app).post("/v1/devices/register").send(registrationBody()).expect(201);
    const bearer = { Authorization: `Bearer ${registration.body.token as string}` };
    await request(app).post("/v1/kyc/start").set(bearer).expect(200, { status: 'provider_required' });
    expect(db.prepare('SELECT COUNT(*) FROM kyc').pluck().get()).toBe(0);
    await request(app).post("/v1/onramp/create").set(bearer).send({ amountInr: 100 }).expect(503)
      .expect(({ body }) => expect(body.error).toBe("NOT_CONFIGURED"));
    db.close();
  });
});
