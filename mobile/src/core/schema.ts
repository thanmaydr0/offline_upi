import { z } from "zod";
import type { Address, Hex, Payment, PaymentProof, ProofItem, StoredVoucher } from "@offline-pay/shared";

const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((value) => value as Address);
const hexSchema = z.string().regex(/^0x(?:[0-9a-fA-F]{2})+$/).transform((value) => value as Hex);
const bytes32Schema = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((value) => value.toLowerCase() as Hex);
export const requestIdSchema = z.string().regex(/^0x[0-9a-fA-F]{32}$/).transform((value) => value.toLowerCase() as Hex);
const bigintSchema = z.union([z.bigint(), z.string().regex(/^-?\d+$/).transform((value) => BigInt(value))]);

export const voucherSchema = z.object({
  voucherId: bytes32Schema,
  device: addressSchema,
  usdcAmount: bigintSchema,
  inrPaise: z.number().int().positive().safe(),
  expiry: bigintSchema,
});

export const storedVoucherSchema = z.object({
  voucher: voucherSchema,
  issuerSig: hexSchema,
});

export const paymentSchema = z.object({
  voucherId: bytes32Schema,
  device: addressSchema,
  payee: addressSchema,
  usdcAmount: bigintSchema,
  deadline: bigintSchema,
});

export const proofItemSchema = z.object({
  voucher: voucherSchema,
  issuerSig: hexSchema,
  payment: paymentSchema,
  deviceSig: hexSchema,
});

export const paymentProofSchema = z.object({
  v: z.literal(1),
  reqId: requestIdSchema,
  items: z.array(proofItemSchema).min(1),
});

export const configInputSchema = z.object({
  serverTime: z.union([z.string().min(1), z.number().finite()]),
  chainId: z.number().int().positive().optional(),
  vaultAddress: addressSchema.optional(),
  limits: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

export type ParsedStoredVoucher = z.infer<typeof storedVoucherSchema>;
export type ParsedPayment = z.infer<typeof paymentSchema>;
export type ParsedProofItem = z.infer<typeof proofItemSchema>;
export type ParsedPaymentProof = z.infer<typeof paymentProofSchema>;
export type ValidatedConfigInput = z.infer<typeof configInputSchema>;

export function parseStoredVoucher(value: unknown): StoredVoucher {
  return storedVoucherSchema.parse(value) as StoredVoucher;
}

export function parsePayment(value: unknown): Payment {
  return paymentSchema.parse(value) as Payment;
}

export function parseProofItem(value: unknown): ProofItem {
  return proofItemSchema.parse(value) as ProofItem;
}

export function parsePaymentProof(value: unknown): PaymentProof {
  return paymentProofSchema.parse(value) as PaymentProof;
}

export function stringifyJson(value: unknown): string {
  return JSON.stringify(value, (_key: string, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item,
  );
}

export function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}
