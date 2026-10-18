import type { Address } from "viem";
import type { ProofItem } from "@offline-pay/shared";

export const REDEEM_STATUS = {
  OK: 0,
  ALREADY_REDEEMED: 1,
  BAD_ISSUER_SIG: 2,
  BAD_DEVICE_SIG: 3,
  VOUCHER_EXPIRED: 4,
  DEADLINE_PASSED: 5,
  DEVICE_FROZEN: 6,
  INSUFFICIENT_COLLATERAL: 7,
  FIELD_MISMATCH: 8,
} as const;

export type RedeemStatus = (typeof REDEEM_STATUS)[keyof typeof REDEEM_STATUS];
export type RedeemResult = { voucherId: string; status: RedeemStatus };

export interface ChainClient {
  fundCollateral(device: Address, usdcAmount: bigint): Promise<void>;
  redeemBatch(items: readonly ProofItem[]): Promise<RedeemResult[]>;
  freeze(device: Address): Promise<void>;
  getCollateral(device: Address): Promise<bigint>;
}
