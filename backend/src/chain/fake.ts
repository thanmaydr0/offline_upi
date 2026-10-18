import { verifyTypedData, type Address } from "viem";
import { PAYMENT_TYPES, VOUCHER_TYPES, type ProofItem } from "@offline-pay/shared";
import type { ChainClient, RedeemResult } from "./types.js";
import { REDEEM_STATUS } from "./types.js";

export type FakeChainOptions = {
  chainId: number;
  vaultAddress: Address;
  issuerAddress: Address;
};

export class FakeChain implements ChainClient {
  private readonly collateral = new Map<string, bigint>();
  private readonly frozen = new Set<string>();
  private readonly redeemed = new Set<string>();

  constructor(private readonly options: FakeChainOptions) {}

  async fundCollateral(device: Address, usdcAmount: bigint): Promise<void> {
    if (usdcAmount <= 0n) throw new RangeError("Collateral amount must be positive");
    const key = device.toLowerCase();
    this.collateral.set(key, (this.collateral.get(key) ?? 0n) + usdcAmount);
  }

  async redeemBatch(items: readonly ProofItem[]): Promise<RedeemResult[]> {
    const now = BigInt(Math.floor(Date.now() / 1000));
    const results: RedeemResult[] = [];
    for (const item of items) {
      const { voucher, payment } = item;
      let status: RedeemResult["status"] = REDEEM_STATUS.OK;
      if (this.redeemed.has(voucher.voucherId.toLowerCase())) status = REDEEM_STATUS.ALREADY_REDEEMED;
      else if (
        voucher.voucherId.toLowerCase() !== payment.voucherId.toLowerCase() ||
        voucher.device.toLowerCase() !== payment.device.toLowerCase() ||
        voucher.usdcAmount !== payment.usdcAmount
      ) status = REDEEM_STATUS.FIELD_MISMATCH;
      else if (!(await this.validIssuerSignature(item))) status = REDEEM_STATUS.BAD_ISSUER_SIG;
      else if (!(await this.validDeviceSignature(item))) status = REDEEM_STATUS.BAD_DEVICE_SIG;
      else if (voucher.expiry < now) status = REDEEM_STATUS.VOUCHER_EXPIRED;
      else if (payment.deadline < now) status = REDEEM_STATUS.DEADLINE_PASSED;
      else if (this.frozen.has(voucher.device.toLowerCase())) status = REDEEM_STATUS.DEVICE_FROZEN;
      else if ((this.collateral.get(voucher.device.toLowerCase()) ?? 0n) < voucher.usdcAmount) status = REDEEM_STATUS.INSUFFICIENT_COLLATERAL;

      if (status === REDEEM_STATUS.OK) {
        this.redeemed.add(voucher.voucherId.toLowerCase());
        const key = voucher.device.toLowerCase();
        this.collateral.set(key, (this.collateral.get(key) ?? 0n) - voucher.usdcAmount);
      }
      results.push({ voucherId: voucher.voucherId, status });
    }
    return results;
  }

  async freeze(device: Address): Promise<void> {
    this.frozen.add(device.toLowerCase());
  }

  async getCollateral(device: Address): Promise<bigint> {
    return this.collateral.get(device.toLowerCase()) ?? 0n;
  }

  private async validIssuerSignature(item: ProofItem): Promise<boolean> {
    try {
      return await verifyTypedData({
        address: this.options.issuerAddress,
        domain: { name: "OfflineVault", version: "1", chainId: this.options.chainId, verifyingContract: this.options.vaultAddress },
        types: VOUCHER_TYPES,
        primaryType: "Voucher",
        message: item.voucher,
        signature: item.issuerSig,
      });
    } catch {
      return false;
    }
  }

  private async validDeviceSignature(item: ProofItem): Promise<boolean> {
    try {
      return await verifyTypedData({
        address: item.payment.device,
        domain: { name: "OfflineVault", version: "1", chainId: this.options.chainId, verifyingContract: this.options.vaultAddress },
        types: PAYMENT_TYPES,
        primaryType: "Payment",
        message: item.payment,
        signature: item.deviceSig,
      });
    } catch {
      return false;
    }
  }
}
