import { getAddress, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { CLOCK_SKEW_SECONDS } from "./constants";
import { PAYMENT_TYPES, VOUCHER_TYPES } from "./typedData";
import { paymentProofSchema } from "./schema";
import type { Payment, PaymentProof, ProofItem, VerificationContext, VerifyResult, Voucher } from "./types";

export async function verifyVoucher(voucher: Voucher, signature: Hex, issuer: Address, domain: VerificationContext["domain"]): Promise<boolean> {
  try {
    const signer = await recoverTypedDataAddress({ domain, types: VOUCHER_TYPES, primaryType: "Voucher", message: voucher, signature });
    return getAddress(signer) === getAddress(issuer);
  } catch { return false; }
}

export async function verifyPayment(payment: Payment, signature: Hex, device: Address, domain: VerificationContext["domain"]): Promise<boolean> {
  try {
    const signer = await recoverTypedDataAddress({ domain, types: PAYMENT_TYPES, primaryType: "Payment", message: payment, signature });
    return getAddress(signer) === getAddress(device);
  } catch { return false; }
}

export async function verifyProofItem(item: ProofItem, context: VerificationContext): Promise<VerifyResult> {
  const { voucher, payment } = item;
  const fail = (reason: string): VerifyResult => ({ ok: false, reason, risk: "high" });
  if (!(await verifyVoucher(voucher, item.issuerSig, context.issuerAddress, context.domain))) return fail("invalid_issuer_signature");
  if (!(await verifyPayment(payment, item.deviceSig, voucher.device, context.domain))) return fail("invalid_device_signature");
  if (getAddress(payment.payee) !== getAddress(context.payeeAddress)) return fail("wrong_payee");
  if (voucher.voucherId.toLowerCase() !== payment.voucherId.toLowerCase() || getAddress(voucher.device) !== getAddress(payment.device) || voucher.usdcAmount !== payment.usdcAmount) return fail("field_mismatch");
  const skew = context.clockSkewSeconds ?? CLOCK_SKEW_SECONDS;
  if (voucher.expiry + skew < context.nowSeconds) return fail("voucher_expired");
  if (payment.deadline + skew < context.nowSeconds) return fail("payment_deadline_passed");
  if (context.revokedDevices.has(voucher.device.toLowerCase())) return fail("device_revoked");
  if (context.seenVoucherIds.has(voucher.voucherId.toLowerCase())) return fail("duplicate_voucher");
  if (BigInt(voucher.inrPaise) > context.maxSinglePaymentPaise) return fail("single_payment_limit");
  if (context.pendingUnsettledPaise + BigInt(voucher.inrPaise) > context.maxUnsettledPaise) return fail("unsettled_limit");
  if (context.domain.chainId !== context.request.chainId) return fail("wrong_chain_id");
  return { ok: true, risk: "low", totalInrPaise: BigInt(voucher.inrPaise) };
}

export async function verifyProof(proof: PaymentProof, context: VerificationContext): Promise<VerifyResult> {
  const parsed = paymentProofSchema.safeParse(proof);
  if (!parsed.success) return { ok: false, reason: "invalid_schema", risk: "high" };
  proof = parsed.data as PaymentProof;
  if (proof.reqId.toLowerCase() !== context.request.reqId.toLowerCase()) return { ok: false, reason: "request_mismatch", risk: "high" };
  if (getAddress(context.request.payee) !== getAddress(context.payeeAddress)) return { ok: false, reason: "request_payee_mismatch", risk: "high" };
  if (proof.items.length === 0) return { ok: false, reason: "empty_proof", risk: "high" };
  const seen = new Set<string>();
  let total = 0n;
  for (const item of proof.items) {
    const id = item.voucher.voucherId.toLowerCase();
    if (seen.has(id)) return { ok: false, reason: "duplicate_voucher", risk: "high" };
    seen.add(id);
    const result = await verifyProofItem(item, { ...context, pendingUnsettledPaise: context.pendingUnsettledPaise + total });
    if (!result.ok) return result;
    total += result.totalInrPaise;
  }
  if (total !== BigInt(context.request.inrPaise)) return { ok: false, reason: "amount_mismatch", risk: "high" };
  return { ok: true, risk: context.pendingUnsettledPaise + total > context.maxUnsettledPaise * 3n / 4n ? "medium" : "low", totalInrPaise: total };
}
