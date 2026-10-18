import "dotenv/config";
import { configVariable, defineConfig } from "hardhat/config";
import hardhatToolboxViem from "@nomicfoundation/hardhat-toolbox-viem";
import { z } from "zod";

const env = z.object({
  DEPLOYER_PRIVATE_KEY: z.union([z.string().regex(/^0x[0-9a-fA-F]{64}$/), z.literal("")]).optional(),
  RPC_URL_BASE_SEPOLIA: z.string().url().optional(),
  BASESCAN_API_KEY: z.string().optional(),
}).parse(process.env);

const networks = {
  baseSepolia: {
    type: "http" as const,
    chainType: "op" as const,
    chainId: 84532,
    url: env.RPC_URL_BASE_SEPOLIA ?? "https://sepolia.base.org",
    accounts: env.DEPLOYER_PRIVATE_KEY ? [configVariable("DEPLOYER_PRIVATE_KEY")] : [],
  },
  base: {
    type: "http" as const,
    chainType: "op" as const,
    chainId: 8453,
    url: "https://mainnet.base.org",
    accounts: env.DEPLOYER_PRIVATE_KEY ? [configVariable("DEPLOYER_PRIVATE_KEY")] : [],
  },
};

export default defineConfig({
  plugins: [hardhatToolboxViem],
  solidity: {
    version: "0.8.30",
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
  },
  verify: { etherscan: { apiKey: env.BASESCAN_API_KEY ?? "" } },
  networks,
});
