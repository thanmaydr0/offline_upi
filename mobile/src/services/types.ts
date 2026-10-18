import type { Address, Hex, Payment, PaymentRequest, PaymentProof, ProofItem, StoredVoucher, VerifyResult, LedgerEntry, IntegrityReport } from "@offline-pay/shared";

export interface KeyService {
  init(): Promise<{ address: Address }>;
  getAddress(): Promise<Address>;
  signPayments(payments: Payment[], reason: string): Promise<Hex[]>;
  integrity(): Promise<IntegrityReport>;
}

export interface VoucherWallet {
  list(): Promise<StoredVoucher[]>;
  addIssued(items: StoredVoucher[]): Promise<void>;
  selectForAmount(inrPaise: number): Promise<StoredVoucher[] | null>;
  markSpent(voucherIds: Hex[], reqId: Hex): Promise<void>;
  offlineBalancePaise(): Promise<bigint>;
}

export interface LedgerService {
  append(entry: Omit<LedgerEntry, "hash" | "previousHash" | "counter">): Promise<LedgerEntry>;
  verifyChain(): Promise<{ ok: boolean; brokenAt?: bigint }>;
  head(): Promise<{ hash: Hex; counter: bigint }>;
  list(): Promise<LedgerEntry[]>;
}

export interface ReceivedStore {
  addVerified(proof: PaymentProof): Promise<void>;
  pending(): Promise<ProofItem[]>;
  markSettled(voucherId: Hex, status: number): Promise<void>;
  seenVoucher(id: Hex): Promise<boolean>;
}

export interface ApiClient {
  register(input: { deviceAddress: Address; deviceName: string; integrity: IntegrityReport }): Promise<{ userId: string; token: string }>;
  getConfig(): Promise<Record<string, unknown>>;
  startKyc(): Promise<void>;
  kycStatus(): Promise<string>;
  createOnramp(amountInr: number): Promise<{ orderId: string; paymentUrl: string; status: string }>;
  onrampStatus(orderId: string): Promise<string>;
  issueVouchers(orderId: string): Promise<StoredVoucher[]>;
  getWallet(): Promise<Record<string, bigint>>;
  postLedgerHead(head: { hash: Hex; counter: bigint }): Promise<{ ok: boolean; flagged: boolean }>;
  settle(items: ProofItem[]): Promise<{ settlementId: string; results: { voucherId: Hex; status: number }[] }>;
  history(): Promise<unknown[]>;
  payouts(): Promise<unknown[]>;
  setVpa(vpa: string): Promise<void>;
}

export interface OfflineFlows {
  createRequest(inrPaise: number): Promise<PaymentRequest>;
  payRequest(request: PaymentRequest): Promise<string[]>;
  receiveFrame(frame: string): Promise<VerifyResult | { progress: number }>;
}

