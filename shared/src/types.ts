import type { Address, Hex } from "viem";

export type Voucher = { voucherId: Hex; device: Address; usdcAmount: bigint; inrPaise: number; expiry: bigint };
export type Payment = { voucherId: Hex; device: Address; payee: Address; usdcAmount: bigint; deadline: bigint };
export type PaymentRequest = { v: 1; payee: Address; inrPaise: number; reqId: Hex; chainId: number; ts: number; name?: string };
export type ProofItem = { voucher: Voucher; issuerSig: Hex; payment: Payment; deviceSig: Hex };
export type PaymentProof = { v: 1; reqId: Hex; items: ProofItem[] };
export type RiskLabel = "low" | "medium" | "high";
export type VerificationContext = {
  domain: { name: "OfflineVault"; version: "1"; chainId: number; verifyingContract: Address };
  issuerAddress: Address;
  payeeAddress: Address;
  request: PaymentRequest;
  nowSeconds: bigint;
  clockSkewSeconds?: bigint;
  revokedDevices: ReadonlySet<string>;
  seenVoucherIds: ReadonlySet<string>;
  maxSinglePaymentPaise: bigint;
  maxUnsettledPaise: bigint;
  pendingUnsettledPaise: bigint;
};
export type VerifyResult = { ok: true; risk: RiskLabel; totalInrPaise: bigint } | { ok: false; reason: string; risk: RiskLabel };
export type StoredVoucher = { voucher: Voucher; issuerSig: Hex };
export type IntegrityReport = { rooted: boolean; isDevice: boolean };
export type LedgerEntry = { hash: Hex; previousHash: Hex; counter: bigint; kind: string };
