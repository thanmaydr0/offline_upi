import { describe, expect, jest, test } from '@jest/globals';
import { FetchApiClient, type FetchTransport } from './client';
import { address, id, proof, voucher } from './__tests__/fixtures';
import { VOUCHER_TYPES } from '@offline-pay/shared';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { SessionStorage } from './storage';
import type { KeyService } from '../services/types';

jest.mock('../core', () => ({ cacheServerConfig: jest.fn(), readCachedServerConfig: jest.fn() }));
jest.mock('./storage', () => ({ sessionStorage: {} }));
jest.mock('expo/virtual/env', () => ({ env: {} }));
const keys: KeyService = { init: async () => ({ address }), getAddress: async () => address,
  integrity: async () => ({ rooted: false, isDevice: true }), signPayments: async () => [] };
function setup() {
  let token: string | null = 'old';
  const storage: SessionStorage = { getToken: async () => token, setToken: async (_origin, value) => { token = value; }, getOverride: async () => 'http://lan.example:3000' };
  const fetcher = jest.fn<FetchTransport>();
  const cache = jest.fn<(value: unknown) => Promise<void>>().mockResolvedValue(undefined);
  const readConfig = jest.fn<() => Promise<unknown>>().mockResolvedValue(null);
  const api = new FetchApiClient({ keys, storage, fetch: fetcher, timeoutMs: 10, cacheConfig: cache, readConfig, baseUrl: 'http://fallback.example' });
  const reply = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;
  return { api, fetcher, storage, cache, reply, readConfig };
}
describe('FetchApiClient', () => {
  test('runtime override, bearer, integer decoding and ledger wire format', async () => {
    const { api, fetcher, reply } = setup();
    fetcher.mockResolvedValueOnce(reply({ onlineInrPaise: 123, offlineIssuedUnspentPaise: '456', pendingSettlementPaise: 0 }));
    expect(await api.getWallet()).toEqual({ onlineInrPaise: 123n, offlineIssuedUnspentPaise: 456n, pendingSettlementPaise: 0n });
    expect(fetcher.mock.calls[0][0]).toBe('http://lan.example:3000/v1/wallet');
    expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({ Authorization: 'Bearer old' });
    fetcher.mockResolvedValueOnce(reply({ ok: true, flagged: false }));
    await api.postLedgerHead({ hash: `0x${'00'.repeat(32)}`, counter: 3n });
    expect(JSON.parse(fetcher.mock.calls[1][1]?.body as string)).toMatchObject({ counter: 3 });
  });
  test('401 re-registers existing device, securely stores token and retries once', async () => {
    const { api, fetcher, reply, storage } = setup();
    fetcher.mockResolvedValueOnce(reply({}, 401)).mockResolvedValueOnce(reply({ userId: 'u', token: 'new' }, 201)).mockResolvedValueOnce(reply({ items: [] }));
    await expect(api.history()).resolves.toEqual([]);
    expect(fetcher.mock.calls).toHaveLength(3);
    expect(await storage.getToken('http://lan.example:3000')).toBe('new');
    expect(fetcher.mock.calls[1][1]?.headers).not.toHaveProperty('Authorization');
    expect(fetcher.mock.calls[2][1]?.headers).toMatchObject({ Authorization: 'Bearer new' });
  });
  test('second 401 fails without looping or exposing response secrets', async () => {
    const { api, fetcher, reply } = setup();
    fetcher.mockResolvedValueOnce(reply({}, 401)).mockResolvedValueOnce(reply({ userId: 'u', token: 'new' })).mockResolvedValueOnce(reply({ token: 'secret' }, 401));
    await expect(api.history()).rejects.toMatchObject({ code: 'HTTP', status: 401, message: 'Backend request failed (401).' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  test('timeout aborts fetch and is typed; network errors are sanitized', async () => {
    const { api, fetcher } = setup();
    fetcher.mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('secret')))));
    await expect(api.history()).rejects.toMatchObject({ code: 'TIMEOUT' });
    fetcher.mockRejectedValueOnce(new Error('secret'));
    await expect(api.history()).rejects.toMatchObject({ code: 'NETWORK' });
  });
  test('config is validated before clock/cache writes', async () => {
    const { api, fetcher, reply, cache } = setup();
    const config = { issuerAddress: address, vaultAddress: address, usdcAddress: address, chainId: 84532, inrPerUsdc: 90,
      denominations: [100], limits: { maxOfflineBalancePaise: 500000 }, revokedDevices: [], serverTime: '2026-10-18T12:00:00.000Z' };
    fetcher.mockResolvedValueOnce(reply(config)); await api.getConfig(); expect(cache).toHaveBeenCalledWith(config);
    fetcher.mockResolvedValueOnce(reply({ ...config, chainId: -1 }));
    await expect(api.getConfig()).rejects.toMatchObject({ code: 'VALIDATION' }); expect(cache).toHaveBeenCalledTimes(1);
  });
  test('fractional money is rejected', async () => {
    const { api, fetcher, reply } = setup();
    fetcher.mockResolvedValueOnce(reply({ onlineInrPaise: 1.5, offlineIssuedUnspentPaise: 0, pendingSettlementPaise: 0 }));
    await expect(api.getWallet()).rejects.toMatchObject({ code: 'VALIDATION' });
  });
  test('mock gateway relative payment URL resolves against selected backend', async () => {
    const { api, fetcher, reply } = setup();
    fetcher.mockResolvedValueOnce(reply({ orderId: 'o1', paymentUrl: '/mock-upi/o1', status: 'pending' }));
    await expect(api.createOnramp(100)).resolves.toMatchObject({ paymentUrl: 'http://lan.example:3000/mock-upi/o1' });
    fetcher.mockResolvedValueOnce(reply({ orderId: 'o2', paymentUrl: 'javascript:alert(1)', status: 'pending' }));
    await expect(api.createOnramp(100)).rejects.toMatchObject({ code: 'VALIDATION' });
  });
  test('issued voucher JSON is decoded and issuer signature/device binding are checked', async () => {
    const { api, fetcher, reply, readConfig } = setup();
    const issuer = privateKeyToAccount(generatePrivateKey());
    const config = { issuerAddress: issuer.address, vaultAddress: address, usdcAddress: address, chainId: 84532,
      inrPerUsdc: 90, denominations: [100], limits: {}, revokedDevices: [], serverTime: '2026-10-18T12:00:00.000Z' };
    readConfig.mockResolvedValue(config);
    const issuerSig = await issuer.signTypedData({ domain: { name: 'OfflineVault', version: '1', chainId: 84532, verifyingContract: address },
      types: VOUCHER_TYPES, primaryType: 'Voucher', message: voucher.voucher });
    const wire = { vouchers: [{ voucher: { ...voucher.voucher, usdcAmount: '11111', expiry: '9999999999' }, issuerSig }] };
    fetcher.mockResolvedValueOnce(reply(wire));
    await expect(api.issueVouchers('o1')).resolves.toEqual([{ ...voucher, issuerSig }]);
    fetcher.mockResolvedValueOnce(reply({ vouchers: [{ ...voucher, issuerSig: '0xab' }] }));
    await expect(api.issueVouchers('o1')).rejects.toMatchObject({ code: 'VALIDATION' });
  });
  test('settlement encodes bigint proof values as decimal JSON strings', async () => {
    const { api, fetcher, reply } = setup();
    fetcher.mockResolvedValueOnce(reply({ settlementId: 's', results: [{ voucherId: id, status: 0 }] }));
    await api.settle([proof]);
    expect(JSON.parse(fetcher.mock.calls[0][1]?.body as string).items[0].payment.usdcAmount).toBe('11111');
  });
  test('concurrent 401 responses share re-registration', async () => {
    const { api, fetcher, reply } = setup();
    fetcher.mockImplementation(async (url, options) => {
      if (url.endsWith('/register')) return reply({ userId: 'u', token: 'new' });
      const headers = options?.headers as Record<string, string>;
      return headers.Authorization === 'Bearer new' ? reply({ items: [] }) : reply({}, 401);
    });
    await Promise.all([api.history(), api.history()]);
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/register'))).toHaveLength(1);
  });
  test('first-run KYC 404 is not_started, allowing startKyc', async () => {
    const { api, fetcher, reply } = setup();
    fetcher.mockResolvedValueOnce(reply({ error: 'KYC_NOT_STARTED' }, 404));
    await expect(api.kycStatus()).resolves.toBe('not_started');
    fetcher.mockResolvedValueOnce(reply({ status: 'pending' }, 202));
    await expect(api.startKyc()).resolves.toBeUndefined();
  });
});
