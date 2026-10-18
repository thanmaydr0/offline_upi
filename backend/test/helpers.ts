import request from "supertest";
import type { Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createApp, createAppRuntime } from "../src/app.js";
import type { BackendEnv } from "../src/env.js";
import { createDatabase, type BackendDatabase } from "../src/db/database.js";
import { FakeChain } from "../src/chain/fake.js";
import { MockGateway } from "../src/gateways/fiat.js";

export const TEST_ISSUER_KEY = `0x${"1".repeat(64)}` as const;
export const TEST_RELAYER_KEY = `0x${"2".repeat(64)}` as const;
export const TEST_DEVICE_KEY = `0x${"3".repeat(64)}` as const;
export const TEST_DEVICE_ADDRESS = privateKeyToAccount(TEST_DEVICE_KEY).address;
export const TEST_ISSUER_ADDRESS = privateKeyToAccount(TEST_ISSUER_KEY).address;
export const TEST_WEBHOOK_SECRET = "test-webhook-secret-value";

export const testEnv: BackendEnv = {
  PORT: 3000,
  DB_PATH: ":memory:",
  JWT_SECRET: "test-jwt-secret-that-is-at-least-32-characters-long",
  CHAIN_MODE: "fake",
  RPC_URL: "https://sepolia.base.org",
  CHAIN_ID: 84532,
  VAULT_ADDRESS: "0x0000000000000000000000000000000000000042",
  USDC_ADDRESS: "0x0000000000000000000000000000000000000043",
  ISSUER_PRIVATE_KEY: TEST_ISSUER_KEY,
  RELAYER_PRIVATE_KEY: TEST_RELAYER_KEY,
  FIAT_GATEWAY: "mock",
  FIAT_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
  ADMIN_USER: "admin",
  ADMIN_PASSWORD: "test-admin-password",
  INR_PER_USDC: 90,
  MAX_OFFLINE_BALANCE_PAISE: 500000,
  MAX_SINGLE_OFFLINE_PAYMENT_PAISE: 200000,
  MAX_OFFLINE_SPEND_24H_PAISE: 500000,
  VOUCHER_TTL_SECONDS: 604800,
  PAYMENT_DEADLINE_SECONDS: 604800,
  MERCHANT_MAX_UNSETTLED_PAISE: 1000000,
  CLOCK_SKEW_SECONDS: 300,
  WITHDRAW_DELAY_SECONDS: 604800,
};

export type TestContext = { app: ReturnType<typeof createApp>; db: BackendDatabase; chain: FakeChain; gateway: MockGateway;
  job: ReturnType<typeof createAppRuntime>['job'] };

export function createTestApp(): TestContext {
  const db = createDatabase(":memory:");
  const gateway = new MockGateway(TEST_WEBHOOK_SECRET);
  const issuerAddress = privateKeyToAccount(TEST_ISSUER_KEY).address;
  const chain = new FakeChain({ chainId: testEnv.CHAIN_ID, vaultAddress: testEnv.VAULT_ADDRESS as Address, issuerAddress });
  const { app, job } = createAppRuntime({ env: testEnv, db, chain, gateway, kycApprovalDelayMs: 100 });
  return { app, db, chain, gateway, job };
}

export function registrationBody(deviceAddress: string = TEST_DEVICE_ADDRESS, integrity = { rooted: false, isDevice: true }) {
  return { deviceAddress, deviceName: "Test phone", integrity };
}

export async function registerDevice(app: TestContext["app"], deviceAddress: string = TEST_DEVICE_ADDRESS) {
  const response = await request(app).post("/v1/devices/register").send(registrationBody(deviceAddress)).expect(201);
  return { userId: response.body.userId as string, token: response.body.token as string };
}

export async function waitForKycApproval(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 150));
}
