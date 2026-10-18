import type { Address } from "viem";
import type { BackendEnv } from "../env.js";
import { FakeChain } from "./fake.js";
import type { ChainClient } from "./types.js";

export class NotConfigured extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotConfigured";
  }
}

export function createChainClient(env: BackendEnv, issuerAddress: Address): ChainClient {
  if (env.CHAIN_MODE === "fake") {
    return new FakeChain({ chainId: env.CHAIN_ID, vaultAddress: env.VAULT_ADDRESS as Address, issuerAddress });
  }
  throw new NotConfigured("CHAIN_MODE=chain requires the P5 real-chain implementation and deployed contract configuration.");
}

export { FakeChain };
export { REDEEM_STATUS } from "./types.js";
export type { ChainClient, RedeemResult, RedeemStatus } from "./types.js";
