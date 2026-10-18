import { z } from 'zod';
import type { Address, Hex } from '@offline-pay/shared';

export const addressSchema = z.string().regex(/^0x[\da-fA-F]{40}$/).transform(v => v as Address);
export const idSchema = z.string().regex(/^0x[\da-fA-F]{64}$/).transform(v => v.toLowerCase() as Hex);
export const hexSchema = z.string().regex(/^0x(?:[\da-fA-F]{2})+$/).transform(v => v as Hex);
export const integerSchema = z.number().int().nonnegative().safe();
export const uintSchema = z.union([z.string().max(78).regex(/^\d+$/), integerSchema, z.bigint().nonnegative()]).transform(v => BigInt(v));
export const moneySchema = uintSchema.refine(v => v <= BigInt(Number.MAX_SAFE_INTEGER), 'Paise exceeds UI integer range');
export const storedVoucherSchema = z.object({
  voucher: z.object({ voucherId: idSchema, device: addressSchema, usdcAmount: uintSchema,
    inrPaise: integerSchema.positive().max(0xffffffff), expiry: uintSchema.refine(v => v <= (1n << 64n) - 1n) }), issuerSig: hexSchema,
});
export const registrationSchema = z.object({ deviceAddress: addressSchema, deviceName: z.string().trim().min(1).max(80),
  integrity: z.object({ rooted: z.boolean(), isDevice: z.boolean() }) });
export const configSchema = z.object({ issuerAddress: addressSchema, vaultAddress: addressSchema,
  usdcAddress: addressSchema, chainId: integerSchema.positive(), inrPerUsdc: integerSchema.positive(),
  denominations: z.array(integerSchema.positive()).min(1), limits: z.record(z.string(), integerSchema),
  revokedDevices: z.array(addressSchema), serverTime: z.union([z.string().datetime(), integerSchema.positive()]),
});
export const statusSchema = z.object({ status: z.string().min(1).max(80) });
export const settlementSchema = z.object({ settlementId: z.string().min(1), results: z.array(z.object({
  voucherId: idSchema, status: integerSchema.max(8),
})) });
export const historyItemSchema = z.object({ id: z.string(), type: z.string(), amountInrPaise: integerSchema,
  status: z.string(), createdAt: integerSchema });
export const payoutSchema = z.object({ payoutId: z.string(), amountInrPaise: integerSchema,
  status: z.string(), createdAt: integerSchema, vpa: z.string().nullable().optional(),
  gatewayReference: z.string().nullable().optional() });
export const urlSchema = z.string().url().refine(value => {
  const url = new URL(value);
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
}, 'Use an http(s) URL without credentials, query or fragment');
export const vpaSchema = z.string().trim().regex(/^[A-Za-z0-9._-]{2,256}@[A-Za-z0-9.-]{2,64}$/);
export type ServerConfig = z.infer<typeof configSchema>;
export type HistoryItem = z.infer<typeof historyItemSchema>;
export type Payout = z.infer<typeof payoutSchema>;
export const encodeJson = (value: unknown): string => JSON.stringify(value, (_, v: unknown) => typeof v === 'bigint' ? v.toString() : v);
