import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { network } from "hardhat";
import { getAddress } from "viem";
import { z } from "zod";

const envSchema = z.object({
  RELAYER_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  ISSUER_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
});

const { RELAYER_ADDRESS, ISSUER_ADDRESS } = envSchema.parse(process.env);

const connection = await network.create();
const { viem } = connection;
const publicClient = await viem.getPublicClient();
const [deployer] = await viem.getWalletClients();

if (deployer?.account === undefined) {
  throw new Error("No deployer account is configured for this network");
}

const deployerAddress = getAddress(deployer.account.address);
const issuerAddress = getAddress(ISSUER_ADDRESS);
const relayerAddress = getAddress(RELAYER_ADDRESS);
const chainId = await publicClient.getChainId();
const networkName = chainId === 84532 ? "baseSepolia" : chainId === 8453 ? "base" : "localhost";

if (networkName === "base" || (networkName === "localhost" && chainId !== 31337 && chainId !== 1337)) {
  throw new Error(`Refusing to deploy the test token to unsupported chain ${chainId}`);
}

const token = await viem.deployContract("MockUSDC");
const vault = await viem.deployContract("OfflineVault", [deployerAddress, token.address, issuerAddress]);
await vault.write.setOperator([relayerAddress]);

const blockNumber = await publicClient.getBlockNumber();
const block = await publicClient.getBlock({ blockNumber });
const root = process.cwd();
const artifactDirectory = resolve(root, "artifacts", "contracts");
const abiDirectory = resolve(root, "..", "shared", "src", "abi");
const deploymentDirectory = resolve(root, "deployments");
await mkdir(abiDirectory, { recursive: true });
await mkdir(deploymentDirectory, { recursive: true });

for (const contractName of ["OfflineVault", "MockUSDC"] as const) {
  const artifactPath = resolve(artifactDirectory, `${contractName}.sol`, `${contractName}.json`);
  const artifact: unknown = JSON.parse(await readFile(artifactPath, "utf8"));
  const artifactSchema = z.object({ abi: z.array(z.unknown()) });
  const parsedArtifact = artifactSchema.parse(artifact);
  const abiPath = resolve(abiDirectory, `${contractName}.json`);
  await writeFile(abiPath, `${JSON.stringify(parsedArtifact.abi, null, 2)}\n`, "utf8");
}

const deployment = {
  network: networkName,
  chainId,
  block: Number(block.number),
  addresses: {
    deployer: deployerAddress,
    issuer: issuerAddress,
    relayer: relayerAddress,
    MockUSDC: token.address,
    OfflineVault: vault.address,
  },
};
const deploymentPath = resolve(deploymentDirectory, `${networkName}.json`);
await writeFile(deploymentPath, `${JSON.stringify(deployment, null, 2)}\n`, "utf8");

console.log(`Network: ${networkName} (${chainId})`);
console.log(`Deployment block: ${block.number}`);
console.log(`MockUSDC: ${token.address}`);
console.log(`OfflineVault: ${vault.address}`);
console.log(`Deployment record: ${deploymentPath}`);
console.log(`Shared ABIs copied to: ${abiDirectory}`);
