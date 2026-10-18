import { jest } from '@jest/globals';
import type { Hex, ProofItem, StoredVoucher } from '@offline-pay/shared';
import type { ApiClient, LedgerService, ReceivedStore, VoucherWallet } from '../../services/types';
import type { LocalStore } from '../storage';
import { encodeJson } from '../schemas';

export const address = `0x${'11'.repeat(20)}` as const;
export const id = `0x${'22'.repeat(32)}` as const;
export const voucher: StoredVoucher = { voucher: { voucherId: id, device: address, usdcAmount: 11111n, inrPaise: 10000, expiry: 9999999999n }, issuerSig: '0xab' };
export const proof: ProofItem = { ...voucher, payment: { voucherId: id, device: address, payee: address, usdcAmount: 11111n, deadline: 9999999999n }, deviceSig: '0xcd' };
export function memoryStore() {
  const values = new Map<string, string>();
  const store: LocalStore = {
    async read(key, schema) { const raw = values.get(key); return raw === undefined ? null : schema.parse(JSON.parse(raw) as unknown); },
    async write(key, value) { values.set(key, encodeJson(value)); },
    async remove(key) { values.delete(key); },
  };
  return { store, values };
}
export function fixture() {
  const { store, values } = memoryStore();
  const stored = new Set<Hex>();
  const pending = new Map<Hex, ProofItem>();
  const entries: Awaited<ReturnType<LedgerService['list']>> = [];
  const api = {
    register: jest.fn<ApiClient['register']>().mockResolvedValue({ userId: 'u', token: 'private-test-token' }),
    getConfig: jest.fn<ApiClient['getConfig']>().mockResolvedValue({}),
    startKyc: jest.fn<ApiClient['startKyc']>().mockResolvedValue(undefined),
    kycStatus: jest.fn<ApiClient['kycStatus']>().mockResolvedValue('approved'),
    createOnramp: jest.fn<ApiClient['createOnramp']>().mockResolvedValue({ orderId: 'order1', paymentUrl: 'https://pay.example/order1', status: 'pending' }),
    onrampStatus: jest.fn<ApiClient['onrampStatus']>().mockResolvedValue('funded'),
    issueVouchers: jest.fn<ApiClient['issueVouchers']>().mockResolvedValue([voucher]),
    getWallet: jest.fn<ApiClient['getWallet']>().mockResolvedValue({ onlineInrPaise: 0n, pendingSettlementPaise: 0n }),
    postLedgerHead: jest.fn<ApiClient['postLedgerHead']>().mockResolvedValue({ ok: true, flagged: false }),
    settle: jest.fn<ApiClient['settle']>().mockImplementation(async items => ({ settlementId: 's1', results: items.map(item => ({ voucherId: item.voucher.voucherId, status: 0 })) })),
    history: jest.fn<ApiClient['history']>().mockResolvedValue([]), payouts: jest.fn<ApiClient['payouts']>().mockResolvedValue([]),
    setVpa: jest.fn<ApiClient['setVpa']>().mockResolvedValue(undefined),
  };
  const wallet = {
    list: jest.fn<VoucherWallet['list']>().mockResolvedValue([]),
    addIssued: jest.fn<VoucherWallet['addIssued']>().mockImplementation(async items => { items.forEach(item => stored.add(item.voucher.voucherId)); }),
    selectForAmount: jest.fn<VoucherWallet['selectForAmount']>().mockResolvedValue(null),
    markSpent: jest.fn<VoucherWallet['markSpent']>().mockResolvedValue(undefined),
    offlineBalancePaise: jest.fn<VoucherWallet['offlineBalancePaise']>().mockResolvedValue(10000n),
  };
  const ledger = {
    list: jest.fn<LedgerService['list']>().mockImplementation(async () => [...entries]),
    append: jest.fn<LedgerService['append']>().mockImplementation(async input => {
      const entry = { ...input, hash: id, previousHash: id, counter: BigInt(entries.length + 1) }; entries.push(entry); return entry;
    }),
    head: jest.fn<LedgerService['head']>().mockResolvedValue({ hash: id, counter: 0n }),
    verifyChain: jest.fn<LedgerService['verifyChain']>().mockResolvedValue({ ok: true }),
  };
  const received = {
    pending: jest.fn<ReceivedStore['pending']>().mockImplementation(async () => [...pending.values()]),
    markSettled: jest.fn<ReceivedStore['markSettled']>().mockImplementation(async id => { pending.delete(id); }),
    seenVoucher: jest.fn<ReceivedStore['seenVoucher']>().mockImplementation(async id => stored.has(id)),
    addVerified: jest.fn<ReceivedStore['addVerified']>().mockResolvedValue(undefined),
  };
  return { api, wallet, ledger, received, store, values, stored, pending, entries };
}
