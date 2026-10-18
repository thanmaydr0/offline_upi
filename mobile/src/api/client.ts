import { z } from 'zod';
import { parsePaymentProof, verifyVoucher } from '@offline-pay/shared';
import type { ApiClient, KeyService } from '../services/types';
import { cacheServerConfig, readCachedServerConfig } from '../core';
import { sessionStorage, type SessionStorage } from './storage';
import { configSchema, encodeJson, historyItemSchema, integerSchema, payoutSchema, registrationSchema,
  moneySchema, settlementSchema, statusSchema, storedVoucherSchema, urlSchema, vpaSchema } from './schemas';

export class ApiError extends Error {
  constructor(public readonly code: 'NETWORK' | 'TIMEOUT' | 'HTTP' | 'VALIDATION' | 'CONFIGURATION', message: string,
    public readonly status?: number) { super(message); this.name = 'ApiError'; }
}
export type FetchTransport = (url: string, options?: RequestInit) => Promise<Response>;
type Dependencies = { keys: KeyService; storage?: SessionStorage; fetch?: FetchTransport; timeoutMs?: number;
  baseUrl?: string; cacheConfig?: typeof cacheServerConfig; readConfig?: typeof readCachedServerConfig };
const authSchema = z.object({ userId: z.string().min(1), token: z.string().min(1).max(8192) });
const ackSchema = z.object({}).passthrough();

export class FetchApiClient implements ApiClient {
  private registration?: Promise<void>;
  private readonly storage: SessionStorage;
  private readonly fetcher: FetchTransport;
  constructor(private readonly deps: Dependencies) { this.storage = deps.storage ?? sessionStorage; this.fetcher = deps.fetch ?? fetch; }
  async baseUrl(): Promise<string> {
    const value = await this.storage.getOverride() || this.deps.baseUrl || process.env.EXPO_PUBLIC_API_URL;
    const parsed = urlSchema.safeParse(value);
    if (!parsed.success) throw new ApiError('CONFIGURATION', 'Set a valid backend URL in Settings.');
    return parsed.data.replace(/\/+$/, '');
  }
  private async request<S extends z.ZodTypeAny>(path: string, schema: S, body?: unknown, auth = true, retry = true, origin?: string): Promise<z.output<S>> {
    const base = origin ?? await this.baseUrl();
    const token = auth ? await this.storage.getToken(base) : null;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.deps.timeoutMs ?? 15000);
    try {
      const response = await this.fetcher(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST',
        headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : encodeJson(body), signal: controller.signal, redirect: 'error' });
      // Do not copy server bodies into errors: a misconfigured server could echo credentials.
      if (response.status === 401 && auth && retry) {
        clearTimeout(timer);
        if (await this.storage.getToken(base) === token) {
          if (!this.registration) this.registration = this.reRegister(base).finally(() => { this.registration = undefined; });
          await this.registration;
        }
        return this.request(path, schema, body, auth, false, base);
      }
      if (!response.ok) throw new ApiError('HTTP', `Backend request failed (${response.status}).`, response.status);
      let value: unknown;
      try { value = await response.json(); } catch { throw new ApiError(timedOut ? 'TIMEOUT' : 'VALIDATION', timedOut ? 'Backend timed out.' : 'Backend returned invalid JSON.'); }
      const parsed = schema.safeParse(value);
      if (!parsed.success) throw new ApiError('VALIDATION', 'Backend response did not match the expected format.');
      return parsed.data;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(timedOut ? 'TIMEOUT' : 'NETWORK', timedOut ? 'Backend timed out. Resume the existing order if payment was started.' : 'Cannot reach the backend. Check the API URL and Wi-Fi.');
    } finally { clearTimeout(timer); }
  }
  private async reRegister(origin: string): Promise<void> {
    const integrity = await this.deps.keys.integrity();
    await this.registerAt({ deviceAddress: await this.deps.keys.getAddress(), deviceName: 'OfflinePay Android',
      integrity: { rooted: integrity.rooted, isDevice: integrity.isDevice } }, origin);
  }
  private async registerAt(input: Parameters<ApiClient['register']>[0], origin: string) {
    const result = await this.request('/v1/devices/register', authSchema, registrationSchema.parse(input), false, false, origin);
    await this.storage.setToken(origin, result.token);
    return result;
  }
  async register(input: Parameters<ApiClient['register']>[0]) { return this.registerAt(input, await this.baseUrl()); }
  async getConfig() {
    const config = await this.request('/v1/config', configSchema, undefined, false);
    await (this.deps.cacheConfig ?? cacheServerConfig)(config);
    return config;
  }
  async cachedConfig() {
    const cached = await (this.deps.readConfig ?? readCachedServerConfig)();
    return cached === null ? null : configSchema.parse(cached);
  }
  async startKyc() { await this.request('/v1/kyc/start', statusSchema, {}); }
  async kycStatus() {
    try { return (await this.request('/v1/kyc/status', statusSchema)).status; }
    catch (error) { if (error instanceof ApiError && error.status === 404) return 'not_started'; throw error; }
  }
  async createOnramp(amountInr: number) {
    const base = await this.baseUrl();
    const order = await this.request('/v1/onramp/create', z.object({ orderId: z.string().min(1), paymentUrl: z.string().min(1), status: z.string() }),
      { amountInr: integerSchema.positive().parse(amountInr) }, true, true, base);
    let paymentUrl: string;
    try {
      paymentUrl = new URL(order.paymentUrl, `${base}/`).toString();
      if (!['http:', 'https:'].includes(new URL(paymentUrl).protocol)) throw new Error();
    } catch { throw new ApiError('VALIDATION', 'Invalid payment URL returned by backend.'); }
    return { ...order, paymentUrl };
  }
  async onrampStatus(orderId: string) { return (await this.request(`/v1/onramp/${encodeURIComponent(orderId)}`, statusSchema)).status; }
  async issueVouchers(orderId: string) {
    const items = (await this.request('/v1/vouchers/issue', z.object({ vouchers: z.array(storedVoucherSchema).min(1).max(1024) }), { orderId: z.string().min(1).parse(orderId) })).vouchers;
    const config = await this.cachedConfig();
    if (!config) throw new ApiError('CONFIGURATION', 'Sync config before issuing vouchers.');
    const address = (await this.deps.keys.getAddress()).toLowerCase();
    const domain = { name: 'OfflineVault', version: '1', chainId: config.chainId, verifyingContract: config.vaultAddress } as const;
    const ids = new Set<string>();
    for (const item of items) {
      if (ids.has(item.voucher.voucherId) || item.voucher.device.toLowerCase() !== address ||
        !await verifyVoucher(item.voucher, item.issuerSig, config.issuerAddress, domain)) {
        throw new ApiError('VALIDATION', 'Issued voucher signature, identity or uniqueness check failed.');
      }
      ids.add(item.voucher.voucherId);
    }
    return items;
  }
  async getWallet() {
    return this.request('/v1/wallet', z.object({ onlineInrPaise: moneySchema, offlineIssuedUnspentPaise: moneySchema, pendingSettlementPaise: moneySchema }));
  }
  async postLedgerHead(head: Parameters<ApiClient['postLedgerHead']>[0]) {
    const counter = integerSchema.parse(Number(head.counter));
    return this.request('/v1/ledger/head', z.object({ ok: z.boolean(), flagged: z.boolean() }), { headHash: head.hash, counter });
  }
  async settle(items: Parameters<ApiClient['settle']>[0]) {
    const proof = parsePaymentProof({ v: 1, reqId: `0x${'00'.repeat(16)}`, items });
    return this.request('/v1/settle', settlementSchema, { items: proof.items });
  }
  async history() { return (await this.request('/v1/wallet/history', z.object({ items: z.array(historyItemSchema) }))).items; }
  async payouts() { return (await this.request('/v1/payouts', z.object({ payouts: z.array(payoutSchema) }))).payouts; }
  async setVpa(vpa: string) { await this.request('/v1/payee/vpa', ackSchema, { vpa: vpaSchema.parse(vpa) }); }
}
