import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ChainClient } from "./chain/types.js";
import { createChainClient } from "./chain/index.js";
import { createDatabase, type BackendDatabase } from "./db/database.js";
import type { BackendEnv } from "./env.js";
import { createFiatGateway, type FiatGateway } from "./gateways/fiat.js";

export type AppContext = {
  env: BackendEnv;
  db: BackendDatabase;
  chain: ChainClient;
  gateway: FiatGateway;
  issuerAccount: ReturnType<typeof privateKeyToAccount>;
  issuerAddress: Address;
  kycApprovalDelayMs: number;
};

export type AppOptions = {
  env: BackendEnv;
  db?: BackendDatabase;
  chain?: ChainClient;
  gateway?: FiatGateway;
  kycApprovalDelayMs?: number;
};

export function createContext(options: AppOptions): AppContext {
  const issuerAccount = privateKeyToAccount(options.env.ISSUER_PRIVATE_KEY as Hex);
  const gateway = options.gateway ?? createFiatGateway(options.env.FIAT_GATEWAY, options.env.FIAT_WEBHOOK_SECRET);
  return {
    env: options.env,
    db: options.db ?? createDatabase(options.env.DB_PATH),
    chain: options.chain ?? createChainClient(options.env, issuerAccount.address),
    gateway,
    issuerAccount,
    issuerAddress: issuerAccount.address,
    kycApprovalDelayMs: options.kycApprovalDelayMs ?? 3000,
  };
}
