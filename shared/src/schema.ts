import { isAddress, type Address, type Hex } from "viem";
import { z } from "zod";
import type { PaymentProof } from "./types";

const address = z.string().refine(isAddress, "Expected an Ethereum address").transform((value) => value as Address);
const bytes32 = z.string().regex(/^0x[\da-fA-F]{64}$/).transform((value) => value as Hex);
const bytes16 = z.string().regex(/^0x[\da-fA-F]{32}$/).transform((value) => value as Hex);
const signature = z.string().regex(/^0x(?:[\da-fA-F]{2})+$/).transform((value) => value as Hex);
const uint = (bits: bigint) => z.bigint().min(0n).max((1n << bits) - 1n);

const voucher = z.object({
  voucherId: bytes32,
  device: address,
  usdcAmount: uint(256n),
  inrPaise: z.number().int().min(0).max(0xffff_ffff),
  expiry: uint(64n),
}).strict();

const payment = z.object({
  voucherId: bytes32,
  device: address,
  payee: address,
  usdcAmount: uint(256n),
  deadline: uint(64n),
}).strict();

export const paymentProofSchema = z.object({
  v: z.literal(1),
  reqId: bytes16,
  items: z.array(z.object({ voucher, issuerSig: signature, payment, deviceSig: signature }).strict()).min(1),
}).strict();

export function parsePaymentProof(value: unknown): PaymentProof {
  return paymentProofSchema.parse(value) as PaymentProof;
}
