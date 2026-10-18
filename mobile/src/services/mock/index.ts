import type {
  Address,
  Hex,
  IntegrityReport,
  LedgerEntry,
  Payment,
  PaymentRequest,
  PaymentProof,
  ProofItem,
  StoredVoucher,
} from '@offline-pay/shared';
import type {
  ApiClient,
  KeyService,
  LedgerService,
  OfflineFlows,
  ReceivedStore,
  VoucherWallet,
} from '../types';

import { createVoucher, demoAddress, initialTransactions, initialVouchers } from './data';

function delay(ms = 240): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let vouchers = [...initialVouchers];
let ledgerEntries: LedgerEntry[] = [];
let nextOrder = 1;
let nextVoucher = 20;
const onrampOrders = new Map<string, number>();
const seenVoucherIds = new Set<Hex>();
let kycApproved = false;

const signature = `0x${'cd'.repeat(65)}` as Hex;
const emptyHash = `0x${'00'.repeat(32)}` as Hex;
const firstIncoming = createVoucher(50_000, 31);
const secondIncoming = createVoucher(20_000, 32);
let received: ProofItem[] = [firstIncoming, secondIncoming].map((item) => ({
  voucher: item.voucher,
  issuerSig: item.issuerSig,
  payment: {
    voucherId: item.voucher.voucherId,
    device: item.voucher.device,
    payee: demoAddress,
    usdcAmount: item.voucher.usdcAmount,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 24 * 60 * 60),
  },
  deviceSig: signature,
}));

export const keyService: KeyService = {
  async init() {
    await delay(180);
    return { address: demoAddress };
  },
  async getAddress() {
    await delay(80);
    return demoAddress;
  },
  async signPayments(payments: Payment[], _reason: string) {
    await delay(220);
    return payments.map(() => signature);
  },
  async integrity(): Promise<IntegrityReport> {
    await delay(120);
    return { rooted: false, isDevice: true };
  },
};

export const voucherWallet: VoucherWallet = {
  async list() {
    await delay(120);
    return [...vouchers];
  },
  async addIssued(items: StoredVoucher[]) {
    await delay(180);
    vouchers = [...vouchers, ...items];
  },
  async selectForAmount(inrPaise: number) {
    await delay(180);
    const available = [...vouchers].sort((a, b) => b.voucher.inrPaise - a.voucher.inrPaise);
    const selected: StoredVoucher[] = [];
    let remaining = inrPaise;
    for (const item of available) {
      if (item.voucher.inrPaise <= remaining) {
        selected.push(item);
        remaining -= item.voucher.inrPaise;
      }
      if (remaining === 0) break;
    }
    return remaining === 0 ? selected : null;
  },
  async markSpent(voucherIds: Hex[], _reqId: Hex) {
    await delay(150);
    const used = new Set(voucherIds);
    vouchers = vouchers.filter((item) => !used.has(item.voucher.voucherId));
  },
  async offlineBalancePaise() {
    await delay(100);
    return vouchers.reduce((sum, item) => sum + BigInt(item.voucher.inrPaise), 0n);
  },
};

export const ledgerService: LedgerService = {
  async append(entry) {
    await delay(160);
    const counter = BigInt(ledgerEntries.length + 1);
    const previousHash = ledgerEntries.at(-1)?.hash ?? emptyHash;
    const hash = `0x${counter.toString(16).padStart(64, '0')}` as Hex;
    const result: LedgerEntry = { ...entry, counter, previousHash, hash };
    ledgerEntries = [...ledgerEntries, result];
    return result;
  },
  async verifyChain() {
    await delay(180);
    return { ok: true };
  },
  async head() {
    await delay(90);
    return { hash: ledgerEntries.at(-1)?.hash ?? emptyHash, counter: BigInt(ledgerEntries.length) };
  },
  async list() {
    await delay(120);
    return [...ledgerEntries];
  },
};

export const receivedStore: ReceivedStore = {
  async addVerified(proof: PaymentProof) {
    await delay(170);
    received = [...received, ...proof.items];
    proof.items.forEach((item) => seenVoucherIds.add(item.voucher.voucherId));
  },
  async pending() {
    await delay(130);
    return [...received];
  },
  async markSettled(voucherId: Hex, _status: number) {
    await delay(170);
    received = received.filter((item) => item.voucher.voucherId !== voucherId);
  },
  async seenVoucher(id: Hex) {
    await delay(60);
    return seenVoucherIds.has(id);
  },
};

export const apiClient: ApiClient = {
  async register(_input: { deviceAddress: Address; deviceName: string; integrity: IntegrityReport }) {
    await delay(350);
    return { userId: 'demo-user-001', token: 'mock-session-token' };
  },
  async getConfig() {
    await delay(140);
    return { issuerAddress: demoAddress, chainId: 84532, inrPerUsdc: 90, denominations: [100, 200, 500, 1_000, 2_000, 5_000, 10_000, 20_000, 50_000] };
  },
  async startKyc() {
    kycApproved = false;
    await delay(450);
    kycApproved = true;
  },
  async kycStatus() {
    await delay(260);
    return kycApproved ? 'approved' : 'pending';
  },
  async createOnramp(amountInr: number) {
    await delay(360);
    const orderId = `demo-order-${nextOrder++}`;
    onrampOrders.set(orderId, amountInr * 100);
    return { orderId, paymentUrl: `mock-upi://${orderId}`, status: 'pending' };
  },
  async onrampStatus(orderId: string) {
    await delay(300);
    return onrampOrders.has(orderId) ? 'paid' : 'not_found';
  },
  async issueVouchers(orderId: string) {
    await delay(390);
    const amount = onrampOrders.get(orderId);
    if (amount === undefined) return [];
    const result: StoredVoucher[] = [];
    let remaining = amount;
    const denominations = [50_000, 20_000, 10_000, 5_000, 2_000, 1_000, 500, 200, 100];
    for (const denomination of denominations) {
      while (remaining >= denomination) {
        result.push(createVoucher(denomination, nextVoucher++));
        remaining -= denomination;
      }
    }
    onrampOrders.delete(orderId);
    return result;
  },
  async getWallet() {
    await delay(160);
    return { onlineInrPaise: 4_623_800n, offlineIssuedUnspentPaise: await voucherWallet.offlineBalancePaise(), pendingSettlementPaise: 70_000n };
  },
  async postLedgerHead(_head) {
    await delay(220);
    return { ok: true, flagged: false };
  },
  async settle(items: ProofItem[]) {
    await delay(480);
    return { settlementId: `demo-settlement-${nextOrder++}`, results: items.map((item) => ({ voucherId: item.voucher.voucherId, status: 0 })) };
  },
  async history() {
    await delay(250);
    return [...initialTransactions];
  },
  async payouts() {
    await delay(220);
    return [{ id: 'demo-payout-1', amountInr: 600, status: 'completed' }];
  },
  async setVpa(_vpa: string) {
    await delay(320);
  },
};

export const offlineFlows: OfflineFlows = {
  async createRequest(inrPaise: number): Promise<PaymentRequest> {
    await delay(130);
    return {
      v: 1,
      payee: demoAddress,
      inrPaise,
      reqId: `0x${'01'.repeat(16)}` as Hex,
      chainId: 84532,
      ts: Math.floor(Date.now() / 1000),
      name: 'Ananya Sharma',
    };
  },
  async payRequest(request: PaymentRequest) {
    await delay(420);
    const selected = await voucherWallet.selectForAmount(request.inrPaise);
    if (!selected) throw new Error('You do not have the exact amount available offline.');
    const payments: Payment[] = selected.map((item) => ({
      voucherId: item.voucher.voucherId,
      device: item.voucher.device,
      payee: request.payee,
      usdcAmount: item.voucher.usdcAmount,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 24 * 60 * 60),
    }));
    await keyService.signPayments(payments, 'Confirm offline payment');
    await voucherWallet.markSpent(selected.map((item) => item.voucher.voucherId), request.reqId);
    await ledgerService.append({ kind: 'payment' });
    return ['OPAY1:1/1:DEMO-PAYMENT-PROOF'];
  },
  async receiveFrame(_frame: string) {
    await delay(300);
    return { ok: false, reason: 'That sample code could not be verified.', risk: 'low' };
  },
};

export const mockServices = {
  keys: keyService,
  wallet: voucherWallet,
  ledger: ledgerService,
  received: receivedStore,
  api: apiClient,
  offline: offlineFlows,
};
