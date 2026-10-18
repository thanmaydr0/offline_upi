import "dotenv/config";
import { z } from "zod";

const address = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const positiveInteger = z.coerce.number().int().positive();
const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DB_PATH: z.string().min(1).default("./offline-pay.sqlite"),
  JWT_SECRET: z.string().min(32),
  CHAIN_MODE: z.enum(["fake", "chain"]).default("fake"),
  RPC_URL: z.string().url(),
  CHAIN_ID: z.coerce.number().int().positive(),
  VAULT_ADDRESS: address,
  USDC_ADDRESS: address,
  ISSUER_PRIVATE_KEY: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  RELAYER_PRIVATE_KEY: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  FIAT_GATEWAY: z.enum(["mock", "onramp"]).default("mock"),
  FIAT_WEBHOOK_SECRET: z.string().min(16),
  ADMIN_USER: z.string().min(1),
  ADMIN_PASSWORD: z.string().min(12),
  INR_PER_USDC: positiveInteger.default(90),
  MAX_OFFLINE_BALANCE_PAISE: positiveInteger.default(500000),
  MAX_SINGLE_OFFLINE_PAYMENT_PAISE: positiveInteger.default(200000),
  MAX_OFFLINE_SPEND_24H_PAISE: positiveInteger.default(500000),
  VOUCHER_TTL_SECONDS: positiveInteger.default(604800),
  PAYMENT_DEADLINE_SECONDS: positiveInteger.default(604800),
  MERCHANT_MAX_UNSETTLED_PAISE: positiveInteger.default(1000000),
  CLOCK_SKEW_SECONDS: z.coerce.number().int().nonnegative().default(300),
  WITHDRAW_DELAY_SECONDS: positiveInteger.default(604800),
});

export type BackendEnv = z.infer<typeof schema>;
export function loadEnv(source: NodeJS.ProcessEnv = process.env): BackendEnv {
  return schema.parse(source);
}
