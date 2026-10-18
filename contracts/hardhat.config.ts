import "dotenv/config";
import { configVariable, defineConfig } from "hardhat/config";

const networks = {
  baseSepolia: {
    type: "http" as const,
    chainType: "op" as const,
    chainId: 84532,
    url: process.env.RPC_URL_BASE_SEPOLIA ?? "https://sepolia.base.org",
    accounts: process.env.DEPLOYER_PRIVATE_KEY ? [configVariable("DEPLOYER_PRIVATE_KEY")] : [],
  },
  base: {
    type: "http" as const,
    chainType: "op" as const,
    chainId: 8453,
    url: "https://mainnet.base.org",
    accounts: process.env.DEPLOYER_PRIVATE_KEY ? [configVariable("DEPLOYER_PRIVATE_KEY")] : [],
  },
};

export default defineConfig({
  solidity: { version: "0.8.24", settings: { optimizer: { enabled: true, runs: 200 } } },
  networks,
});
