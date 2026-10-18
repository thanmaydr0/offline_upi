import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';
import request from 'supertest';
import { createTestClient, http } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { PAYMENT_TYPES, VOUCHER_TYPES, type ProofItem } from '@offline-pay/shared';
import { startLocalChain, localRelayerKey } from '../scripts/local-chain.js';
import { createSettlementApp } from '../scripts/runtime.js';
import { testEnv } from './helpers.js';
import { RealChain, stringify, vaultAbi, tokenAbi } from '../src/chain/real/index.js';
import { ReconciliationJob } from '../src/jobs/reconcile.js';
import { SettlementService } from '../src/routes/settle-service.js';
import { createDatabase } from '../src/db/database.js';

describe('settlement against spawned Hardhat', () => {
  let local: Awaited<ReturnType<typeof startLocalChain>>;
  let runtime: ReturnType<typeof createSettlementApp>;
  let chain: RealChain;
  const issuer = privateKeyToAccount(localRelayerKey);
  const payer = privateKeyToAccount(generatePrivateKey());
  const payee = privateKeyToAccount(generatePrivateKey());
  const other = privateKeyToAccount(generatePrivateKey());
  let payerToken: string;
  let payeeToken: string;
  let otherToken: string;
  let original: ProofItem;
  const send = (items: ProofItem[], token = payeeToken) => request(runtime.app).post('/v1/settle').set('authorization', `Bearer ${token}`).send(JSON.parse(stringify({ items })));
  async function proof(account = payer, recipient = payee.address): Promise<ProofItem> {
    const voucher = { voucherId: `0x${randomBytes(32).toString('hex')}` as `0x${string}`, device: account.address, usdcAmount: 1000n, inrPaise: 100, expiry: BigInt(Math.floor(Date.now()/1000)+3600) };
    const payment = { voucherId: voucher.voucherId, device: account.address, payee: recipient, usdcAmount: voucher.usdcAmount, deadline: voucher.expiry };
    const domain = { name: 'OfflineVault', version: '1', chainId: 31337, verifyingContract: local.vault } as const;
    return { voucher, payment, issuerSig: await issuer.signTypedData({ domain, types: VOUCHER_TYPES, primaryType: 'Voucher', message: voucher }), deviceSig: await account.signTypedData({ domain, types: PAYMENT_TYPES, primaryType: 'Payment', message: payment }) };
  }
  beforeAll(async () => {
    local = await startLocalChain(18545);
    runtime = createSettlementApp({ ...testEnv, CHAIN_MODE: 'chain', CHAIN_ID: 31337, RPC_URL: local.rpc, VAULT_ADDRESS: local.vault, USDC_ADDRESS: local.token, RELAYER_PRIVATE_KEY: localRelayerKey, ISSUER_PRIVATE_KEY: localRelayerKey });
    chain = runtime.context.chain as RealChain;
    async function register(address: string) {
      const result = await request(runtime.app).post('/v1/devices/register').send({ deviceAddress: address, deviceName: 'Settlement test', integrity: { rooted: false, isDevice: true } }).expect(201);
      return result.body.token as string;
    }
    payerToken = await register(payer.address); payeeToken = await register(payee.address); otherToken = await register(other.address);
    for (const token of [payeeToken, otherToken]) await request(runtime.app).post('/v1/payee/vpa').set('authorization', `Bearer ${token}`).send({ vpa: 'settlement@testbank' }).expect(200);
  }, 60_000);
  afterAll(() => { runtime?.context.db.close(); local?.close(); });

  it('funds via signed webhook, issues, offline signs, settles and pays once', async () => {
    const { db, gateway } = runtime.context;
    const payerRow = db.prepare('SELECT user_id FROM devices WHERE lower(address) = ?').get(payer.address.toLowerCase()) as { user_id: string };
    db.prepare("INSERT INTO kyc VALUES (?, 'approved', ?, ?)").run(payerRow.user_id, 1, 1);
    const order = await request(runtime.app).post('/v1/onramp/create').set('authorization', `Bearer ${payerToken}`).send({ amountInr: 20 }).expect(201);
    const { MockGateway } = await import('../src/gateways/fiat.js');
    const webhook = (gateway as InstanceType<typeof MockGateway>).signWebhook({ eventId: crypto.randomUUID(), orderId: order.body.orderId, status: 'paid', amountInrPaise: 2000 });
    await request(runtime.app).post('/v1/webhooks/fiat').set('content-type', 'application/json').set('x-fiat-signature', webhook.signature).send(webhook.rawBody.toString()).expect(200);
    const issued = await request(runtime.app).post('/v1/vouchers/issue').set('authorization', `Bearer ${payerToken}`).send({ orderId: order.body.orderId }).expect(201);
    const entry = issued.body.vouchers[0];
    const voucher = { ...entry.voucher, usdcAmount: BigInt(entry.voucher.usdcAmount), expiry: BigInt(entry.voucher.expiry) } as ProofItem['voucher'];
    const payment = { voucherId: voucher.voucherId, device: payer.address, payee: payee.address, usdcAmount: voucher.usdcAmount, deadline: voucher.expiry };
    original = { voucher, payment, issuerSig: entry.issuerSig, deviceSig: await payer.signTypedData({ domain: { name: 'OfflineVault', version: '1', chainId: 31337, verifyingContract: local.vault }, types: PAYMENT_TYPES, primaryType: 'Payment', message: payment }) };
    const result = await send([original]).expect(200);
    expect(result.body.results[0].status).toBe(0);
    await request(runtime.app).get(`/v1/settle/${result.body.settlementId}`).set('authorization', `Bearer ${payeeToken}`).expect(200);
    await request(runtime.app).get(`/v1/settle/${result.body.settlementId}`).set('authorization', `Bearer ${otherToken}`).expect(404);
    db.prepare('UPDATE payouts SET created_at = created_at - 2').run();
    await runtime.job.run();
    const payouts = await request(runtime.app).get('/v1/payouts').set('authorization', `Bearer ${payeeToken}`).expect(200);
    expect(payouts.body.payouts[0].status).toBe('paid');
    expect((db.prepare('SELECT inr_paise FROM payee_online_balances').get() as { inr_paise: number }).inr_paise).toBe(voucher.inrPaise);
    expect((await request(runtime.app).get('/v1/wallet').set('authorization', `Bearer ${payeeToken}`).expect(200)).body.onlineInrPaise).toBe(voucher.inrPaise);
    expect((await send([original, original]).expect(200)).body.results).toHaveLength(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM payouts').get() as { n: number }).n).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM double_spend_attempts').get() as { n: number }).n).toBe(0);
  }, 60_000);

  it('rejects garbage and wrong payee before gas', async () => {
    const spy = vi.spyOn(chain, 'redeemBatch');
    await send([{ ...original, issuerSig: `0x${'01'.repeat(65)}` }]).expect(400);
    await send([original], otherToken).expect(400);
    await request(runtime.app).post('/v1/settle').send({ items: [] }).expect(401);
    expect(spy).not.toHaveBeenCalled(); spy.mockRestore();
  });
  it('handles a batch of 20 and relayer restart without another transaction', async () => {
    const items = await Promise.all(Array.from({ length: 20 }, () => proof()));
    await chain.fundCollateral(payer.address, 30_000n);
    const result = await send(items).expect(200);
    expect(result.body.results.map((row: { status: number }) => row.status)).toEqual(Array(20).fill(0));
    const journalPath = join(tmpdir(), `offlinepay-settlement-${randomBytes(12).toString('hex')}.sqlite`);
    let journalDb = createDatabase(journalPath);
    const restartItem = await proof();
    const restarted = new RealChain(runtime.context.env, journalDb);
    const first = await restarted.redeemBatch([restartItem], 'restart-test');
    const nonce = await chain.publicClient.getTransactionCount({ address: chain.account.address });
    journalDb.close();
    journalDb = createDatabase(journalPath);
    try {
      const again = new RealChain(runtime.context.env, journalDb);
      expect(await again.redeemBatch([restartItem], 'restart-test')).toEqual(first);
      expect(await chain.publicClient.getTransactionCount({ address: chain.account.address })).toBe(nonce);
      await expect(again.redeemBatch([await proof()], 'restart-test')).rejects.toThrow('payload mismatch');
    } finally {
      journalDb.close();
      for (const suffix of ['', '-wal', '-shm']) { try { unlinkSync(`${journalPath}${suffix}`); } catch { /* SQLite may already remove sidecars. */ } }
    }
  }, 60_000);
  it('reconciles a missed receipt, then detects a conflicting second payee and freezes', async () => {
    const db = runtime.context.db;
    const item = await proof();
    const saved = chain.redeemBatch.bind(chain);
    const spy = vi.spyOn(chain, 'redeemBatch').mockImplementationOnce(async items => { await saved(items); throw new Error('receipt lost'); });
    await send([item]).expect(500); spy.mockRestore();
    const freshService = new SettlementService(runtime.context);
    await new ReconciliationJob(runtime.context, freshService).run();
    expect((db.prepare('SELECT status FROM settlement_proofs WHERE voucher_id = ?').get(item.voucher.voucherId.toLowerCase()) as { status: number }).status).toBe(0);
    const payment = { ...original.payment, payee: other.address };
    const attack: ProofItem = { ...original, payment, deviceSig: await payer.signTypedData({ domain: { name: 'OfflineVault', version: '1', chainId: 31337, verifyingContract: local.vault }, types: PAYMENT_TYPES, primaryType: 'Payment', message: payment }) };
    expect((await send([attack], otherToken).expect(200)).body.results[0].status).toBe(1);
    expect(await chain.publicClient.readContract({ address: local.vault, abi: vaultAbi, functionName: 'frozen', args: [payer.address] })).toBe(true);
    expect((db.prepare('SELECT COUNT(*) AS n FROM double_spend_attempts').get() as { n: number }).n).toBe(1);
    const config = await request(runtime.app).get('/v1/config').expect(200);
    expect(config.body.revokedDevices.map((value: string) => value.toLowerCase())).toContain(payer.address.toLowerCase());
    await send([await proof()]).expect(400);
    expect((await chain.redeemBatch([await proof()]))[0].status).toBe(6);
  }, 60_000);
  it('never auto-mints locally; rejects RPC chain mismatch before broadcast', async () => {
    const balance = await chain.publicClient.readContract({ address: local.token, abi: tokenAbi, functionName: 'balanceOf', args: [chain.account.address] }) as bigint;
    const fresh = privateKeyToAccount(generatePrivateKey());
    await chain.fundCollateral(fresh.address, 100n);
    expect(await chain.publicClient.readContract({ address: local.token, abi: tokenAbi, functionName: 'balanceOf', args: [chain.account.address] })).toBe(balance - 100n);
    const wrong = new RealChain({ ...runtime.context.env, CHAIN_ID: 8453 }, runtime.context.db);
    await expect(wrong.freeze(fresh.address)).rejects.toThrow('RPC chain ID mismatch');
  }, 60_000);
  it('stops issuance before withdrawal and automatically executes only after the vault delay', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const registered = await request(runtime.app).post('/v1/devices/register').send({ deviceAddress: account.address, deviceName: 'Withdrawal test', integrity: { rooted: false, isDevice: true } }).expect(201);
    const token = registered.body.token as string;
    await chain.fundCollateral(account.address, 5000n);
    const result = await request(runtime.app).post('/v1/settle/withdraw/request').set('authorization', `Bearer ${token}`).send({ amount: '5000' }).expect(200);
    expect(BigInt(result.body.unlockAt)).toBeGreaterThan(BigInt(Math.floor(Date.now()/1000)));
    const row = runtime.context.db.prepare('SELECT frozen FROM devices WHERE lower(address) = ?').get(account.address.toLowerCase()) as { frozen: number };
    expect(row.frozen).toBe(1);
    await runtime.job.run();
    expect(await chain.getCollateral(account.address)).toBe(5000n);
    const clock = createTestClient({ chain: chain.publicClient.chain, mode: 'hardhat', transport: http(local.rpc) });
    await clock.increaseTime({ seconds: 604801 });
    await clock.mine({ blocks: 1 });
    await runtime.job.run();
    expect(await chain.getCollateral(account.address)).toBe(0n);
    expect(await chain.publicClient.readContract({ address: local.token, abi: tokenAbi, functionName: 'balanceOf', args: [account.address] })).toBe(5000n);
  }, 60_000);
});
