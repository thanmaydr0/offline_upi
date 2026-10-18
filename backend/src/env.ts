import "dotenv/config";
import { z } from "zod";

const address = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const positiveInteger = z.coerce.number().int().positive().safe();
const privateKey = z.string().regex(/^0x[a-fA-F0-9]{64}$/);

const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DB_PATH: z.string().min(1).default("./offline-pay.sqlite"),
  JWT_SECRET: z.string().min(32),
  CHAIN_MODE: z.enum(["fake", "chain"]).default("fake"),
  RPC_URL: z.string().url().default("https://sepolia.base.org"),
  CHAIN_ID: positiveInteger.default(84532),
  VAULT_ADDRESS: address.default("0x0000000000000000000000000000000000000000"),
  USDC_ADDRESS: address.default("0x0000000000000000000000000000000000000000"),
  ISSUER_PRIVATE_KEY: privateKey,
  RELAYER_PRIVATE_KEY: privateKey,
  FIAT_GATEWAY: z.enum(["mock", "onramp"]).default("mock"),
  FIAT_WEBHOOK_SECRET: z.string().min(16),
  ADMIN_USER: z.string().min(1).default("admin"),
  ADMIN_PASSWORD: z.string().min(12),
  INR_PER_USDC: positiveInteger.default(90),
  MAX_OFFLINE_BALANCE_PAISE: positiveInteger.default(500000),
  MAX_SINGLE_OFFLINE_PAYMENT_PAISE: positiveInteger.default(200000),
  MAX_OFFLINE_SPEND_24H_PAISE: positiveInteger.default(500000),
  VOUCHER_TTL_SECONDS: positiveInteger.default(604800),
  PAYMENT_DEADLINE_SECONDS: positiveInteger.default(604800),
  MERCHANT_MAX_UNSETTLED_PAISE: positiveInteger.default(1000000),
  CLOCK_SKEW_SECONDS: z.coerce.number().int().nonnegative().safe().default(300),
  WITHDRAW_DELAY_SECONDS: positiveInteger.default(604800),
});

export type BackendEnv = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): BackendEnv {
  return schema.parse(source);
}
