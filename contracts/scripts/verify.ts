import "dotenv/config";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import hre from "hardhat";
import { verifyContract } from "@nomicfoundation/hardhat-verify/verify";
import { z } from "zod";

const argsSchema = z.object({
  network: z.enum(["baseSepolia", "base"]).default("baseSepolia"),
});
const { network: networkName } = argsSchema.parse({ network: process.argv[2] });
const deploymentPath = resolve(process.cwd(), "deployments", `${networkName}.json`);
const deploymentSchema = z.object({
  addresses: z.object({
    deployer: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    issuer: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    MockUSDC: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    OfflineVault: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  }),
});
const deployment = deploymentSchema.parse(JSON.parse(await readFile(deploymentPath, "utf8")));

await verifyContract(
  {
    address: deployment.addresses.OfflineVault,
    constructorArgs: [deployment.addresses.deployer, deployment.addresses.MockUSDC, deployment.addresses.issuer],
    provider: "etherscan",
  },
  hre,
);

console.log(`Verified OfflineVault at ${deployment.addresses.OfflineVault}`);
