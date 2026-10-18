import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';
import { encodeAbiParameters, encodeEventTopics, parseAbiItem } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { OnrampMoneyGateway } from '../src/gateways/onramp.js';
import { decimalPaise, OnrampService } from '../src/services/onramp.js';
import { createTestApp, registerDevice, testEnv, TEST_DEVICE_ADDRESS, TEST_ISSUER_ADDRESS, TEST_RELAYER_KEY } from './helpers.js';
import { createApp } from '../src/app.js';
import { createContext } from '../src/context.js';

const rpc = vi.hoisted(() => ({ getChainId: vi.fn(), readContract: vi.fn(), getBalance: vi.fn(), getTransactionReceipt: vi.fn(), getBlockNumber: vi.fn(), getBlock: vi.fn() }));
vi.mock('viem', async importOriginal => ({ ...await importOriginal<typeof import('viem')>(), createPublicClient: () => rpc }));

const recipient = privateKeyToAccount(TEST_RELAYER_KEY).address;
const env = { ...testEnv, FIAT_GATEWAY: 'onramp' as const, CHAIN_MODE: 'chain' as const,
  CHAIN_ID: 8453, USDC_ADDRESS: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  ONRAMP_APP_ID: 2621907, ONRAMP_API_KEY: 'unit-test-api-key', ONRAMP_API_SECRET: 'unit-test-api-secret',
  ONRAMP_NETWORK: 'base', ONRAMP_CHAIN_ID: 999, ONRAMP_COIN_ID: 123,
}; // Provider IDs are test fixtures, not production mapping values.
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

function setupRpc() {
  rpc.getChainId.mockResolvedValue(8453);
  rpc.getBalance.mockResolvedValue(100000n);
  rpc.readContract.mockImplementation(async ({ functionName }: { functionName: string }) =>
    functionName === 'usdc' ? env.USDC_ADDRESS : functionName === 'operator' ? recipient : TEST_ISSUER_ADDRESS);
}

describe('Onramp live adapter', () => {
  it('blocks missing credentials, fake chain, testnet and incorrect native token', () => {
    expect(() => new OnrampMoneyGateway().requireLiveConfiguration()).toThrow('credentials');
    for (const override of [{ CHAIN_MODE: 'fake' as const }, { CHAIN_ID: 84532 }, { USDC_ADDRESS: testEnv.USDC_ADDRESS }]) {
      expect(() => new OnrampMoneyGateway({ ...env, ...override }).requireLiveConfiguration()).toThrow('mainnet');
    }
  });
  it('creates documented hosted UPI checkout with order correlation and no secrets', async () => {
    setupRpc();
    const id = randomUUID();
    const result = await new OnrampMoneyGateway(env).createOnramp({ orderId: id, amountInrPaise: 10000 });
    const url = new URL(result.paymentUrl);
    expect(url.origin).toBe('https://onramp.money');
    expect(url.searchParams.get('merchantRecognitionId')).toBe(id);
    expect(url.searchParams.get('walletAddress')).toBe(recipient);
    expect(url.searchParams.get('fiatAmount')).toBe('100');
    expect(url.searchParams.get('paymentMethod')).toBe('1');
    expect(result.paymentUrl).not.toContain(env.ONRAMP_API_SECRET);
  });
  it('blocks an RPC/vault mismatch before returning a payment URL', async () => {
    setupRpc(); rpc.getChainId.mockResolvedValue(84532);
    await expect(new OnrampMoneyGateway(env).createOnramp({ orderId: randomUUID(), amountInrPaise: 10000 })).rejects.toThrow('preflight');
  });
  it('validates HMAC-SHA512 and rejects synthetic webhook authentication', () => {
    const gateway = new OnrampMoneyGateway(env);
    const payload = 'signed-header-payload';
    const signature = createHmac('sha512', env.ONRAMP_API_SECRET).update(payload).digest('hex');
    expect(gateway.verifyNotification(payload, signature)).toBe(true);
    expect(gateway.verifyNotification(payload + 'x', signature)).toBe(false);
    expect(gateway.verifyNotification(payload, 'aa')).toBe(false);
    expect(gateway.verifyWebhook(Buffer.from('{}'), signature)).toBe(false);
  });
  it('authenticates provider history calls and paginates authoritative results', async () => {
    const orderId = randomUUID();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ status: 1, data: Array.from({ length: 500 }, () => ({ orderId: 1 })) }))
      .mockResolvedValueOnce(Response.json({ status: 1, data: [{ orderId: 7, merchantRecognitionId: orderId, walletAddress: recipient,
        coinId: 123, chainId: 999, fiatType: 1, fiatAmount: 100, status: 5, transactionHash: `0x${'a'.repeat(64)}` }] }));
    const tx = await new OnrampMoneyGateway(env, fetcher).findTransaction(7, new Date(0).toISOString());
    expect(tx.merchantRecognitionId).toBe(orderId);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const options = fetcher.mock.calls[0]![1]!;
    const headers = options.headers as Record<string, string>;
    const decoded = JSON.parse(Buffer.from(headers['X-ONRAMP-PAYLOAD']!, 'base64').toString()) as { body: unknown };
    expect(decoded.body).toEqual(JSON.parse(options.body as string));
    expect(headers['X-ONRAMP-SIGNATURE']).toBe(createHmac('sha512', env.ONRAMP_API_SECRET).update(headers['X-ONRAMP-PAYLOAD']!).digest('hex'));
  });
  it('uses exact paise and rejects excess precision or exponent notation', () => {
    expect(decimalPaise('478.49')).toBe(47849n);
    expect(decimalPaise(100)).toBe(10000n);
    expect(() => decimalPaise('1.001')).toThrow();
    expect(() => decimalPaise('1e3')).toThrow();
  });
});

describe('Onramp durable reconciliation', () => {
  async function fixture() {
    const test = createTestApp();
    const gateway = new OnrampMoneyGateway(env);
    const app = createApp({ env, db: test.db, chain: test.chain, gateway });
    const auth = await registerDevice(app);
    const device = test.db.prepare('SELECT id FROM devices WHERE address = ?').pluck().get(TEST_DEVICE_ADDRESS.toLowerCase()) as string;
    const id = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    test.db.prepare("INSERT INTO orders VALUES (?, ?, ?, 10000, '0', 'pending', ?, ?)").run(id, auth.userId, device, now, now);
    const ctx = createContext({ env, db: test.db, chain: test.chain, gateway });
    const service = new OnrampService(ctx);
    const body = { eventType: 'onramp', orderId: 7, merchantRecognitionId: id };
    const payload = 'notification';
    const headers = { 'x-onramp-payload': payload, 'x-onramp-signature': createHmac('sha512', env.ONRAMP_API_SECRET).update(payload).digest('hex') };
    const providerTx = { orderId: 7, merchantRecognitionId: id, walletAddress: recipient, coinId: 123, chainId: 999,
      fiatType: 1, fiatAmount: 100, status: 5, transactionHash: `0x${'a'.repeat(64)}` };
    return { ...test, app, id, headers, body, gateway, service, providerTx };
  }
  it('rejects unsigned notifications and queues duplicates once without credit', async () => {
    const f = await fixture();
    try {
      await request(f.app).post('/v1/webhooks/onramp').send(f.body).expect(401);
      await request(f.app).post('/v1/webhooks/onramp').set(f.headers).send(f.body).expect(202);
      await request(f.app).post('/v1/webhooks/onramp').set(f.headers).send(f.body).expect(202, { accepted: true, replayed: true });
      expect(f.db.prepare('SELECT COUNT(*) FROM onramp_receipts').pluck().get()).toBe(1);
      expect(f.db.prepare('SELECT status FROM orders WHERE id = ?').pluck().get(f.id)).toBe('pending');
      await request(f.app).post('/v1/webhooks/fiat').send({}).expect(404);
      await request(f.app).get(`/mock-upi/${f.id}`).expect(404);
    } finally { f.db.close(); }
  });
  it('never funds a mismatched provider transaction', async () => {
    const f = await fixture();
    try {
      vi.spyOn(f.gateway, 'findTransaction').mockResolvedValue({ ...f.providerTx, fiatAmount: 101 });
      const fund = vi.spyOn(f.chain, 'fundCollateral');
      await request(f.app).post('/v1/webhooks/onramp').set(f.headers).send(f.body).expect(202);
      await f.service.processPending();
      expect(fund).not.toHaveBeenCalled();
      expect(f.db.prepare('SELECT reason FROM onramp_receipts').pluck().get()).toBe('provider_details_mismatch');
    } finally { f.db.close(); }
  });
  it('requires finalized USDC delivery and funds only once across webhook retries', async () => {
    const f = await fixture();
    try {
      setupRpc();
      vi.spyOn(f.gateway, 'findTransaction').mockResolvedValue(f.providerTx);
      rpc.getBlock.mockResolvedValue({ number: 112n });
      rpc.getBlockNumber.mockResolvedValue(112n);
      const event = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
      rpc.getTransactionReceipt.mockResolvedValue({ status: 'success', blockNumber: 100n,
        logs: [{ address: env.USDC_ADDRESS, topics: encodeEventTopics({ abi: [event], eventName: 'Transfer', args: { from: TEST_DEVICE_ADDRESS, to: recipient } }),
          data: encodeAbiParameters([{ type: 'uint256' }], [2000000n]), logIndex: 0, transactionIndex: 0, removed: false }] });
      const fund = vi.spyOn(f.chain, 'fundCollateral');
      await request(f.app).post('/v1/webhooks/onramp').set(f.headers).send(f.body).expect(202);
      await f.service.processPending();
      expect(fund).toHaveBeenCalledTimes(1);
      expect(f.db.prepare('SELECT state FROM onramp_receipts').pluck().get()).toBe('done');
      await request(f.app).post('/v1/webhooks/onramp').set(f.headers).send(f.body).expect(202);
      await f.service.processPending();
      expect(fund).toHaveBeenCalledTimes(1);
    } finally { f.db.close(); }
  });
  it('does not fund until withdrawal is finalized or when the token differs', async () => {
    const f = await fixture();
    try {
      setupRpc();
      vi.spyOn(f.gateway, 'findTransaction').mockResolvedValue(f.providerTx);
      rpc.getBlock.mockResolvedValue({ number: 99n });
      rpc.getBlockNumber.mockResolvedValue(112n);
      rpc.getTransactionReceipt.mockResolvedValue({ status: 'success', blockNumber: 100n, logs: [] });
      const fund = vi.spyOn(f.chain, 'fundCollateral');
      await request(f.app).post('/v1/webhooks/onramp').set(f.headers).send(f.body).expect(202);
      await f.service.processPending();
      expect(fund).not.toHaveBeenCalled();
      expect(f.db.prepare('SELECT state FROM onramp_receipts').pluck().get()).toBe('queued');
      rpc.getBlock.mockResolvedValue({ number: 112n });
      await f.service.processPending();
      expect(fund).not.toHaveBeenCalled();
      expect(f.db.prepare('SELECT reason FROM onramp_receipts').pluck().get()).toBe('net_usdc_below_required_collateral');
    } finally { f.db.close(); }
  });
  it('never automatically repeats a collateral call with an uncertain result', async () => {
    const f = await fixture();
    try {
      setupRpc();
      vi.spyOn(f.gateway, 'findTransaction').mockResolvedValue(f.providerTx);
      rpc.getBlock.mockResolvedValue({ number: 112n });
      rpc.getBlockNumber.mockResolvedValue(112n);
      const event = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
      rpc.getTransactionReceipt.mockResolvedValue({ status: 'success', blockNumber: 100n,
        logs: [{ address: env.USDC_ADDRESS, topics: encodeEventTopics({ abi: [event], eventName: 'Transfer', args: { from: TEST_DEVICE_ADDRESS, to: recipient } }),
          data: encodeAbiParameters([{ type: 'uint256' }], [2000000n]), logIndex: 0, transactionIndex: 0, removed: false }] });
      const fund = vi.spyOn(f.chain, 'fundCollateral').mockRejectedValue(new Error('connection lost after broadcast'));
      await request(f.app).post('/v1/webhooks/onramp').set(f.headers).send(f.body).expect(202);
      await f.service.processPending();
      await f.service.processPending();
      expect(fund).toHaveBeenCalledTimes(1);
      expect(f.db.prepare('SELECT reason FROM onramp_receipts').pluck().get()).toBe('funding_outcome_uncertain');
      expect(f.db.prepare('SELECT status FROM orders WHERE id = ?').pluck().get(f.id)).toBe('processing');
    } finally { f.db.close(); }
  });
});
