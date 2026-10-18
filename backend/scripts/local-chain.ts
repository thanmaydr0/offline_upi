import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, defineChain, http, type Abi, type Hex, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const localRelayerKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const; // Public Hardhat key. Local use only.
export async function startLocalChain(port = 8545): Promise<{ process: ChildProcess; rpc: string; vault: Address; token: Address; close: () => void }> {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../node_modules/hardhat/dist/src/cli.js', import.meta.url)), 'node', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: `${root}/contracts`, stdio: 'ignore', windowsHide: true });
  const rpc = `http://127.0.0.1:${port}`;
  const chain = defineChain({ id: 31337, name: 'Hardhat', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  const client = createPublicClient({ chain, transport: http(rpc, { retryCount: 0 }) });
  try {
    let ready = false;
    for (let i = 0; i < 240; i++) { if (child.exitCode !== null) throw new Error(`Hardhat exited: ${child.exitCode}`); try { await client.getChainId(); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 250)); } }
    if (!ready) throw new Error('Hardhat failed to start');
    const account = privateKeyToAccount(localRelayerKey);
    const wallet = createWalletClient({ chain, account, transport: http(rpc) });
    const artifact = (name: string) => JSON.parse(readFileSync(`${root}/contracts/artifacts/contracts/${name}.sol/${name}.json`, 'utf8')) as { abi: Abi; bytecode: Hex };
    const tokenArtifact = artifact('MockUSDC');
    const tokenReceipt = await client.waitForTransactionReceipt({ hash: await wallet.deployContract(tokenArtifact) });
    const token = tokenReceipt.contractAddress!;
    const vaultReceipt = await client.waitForTransactionReceipt({ hash: await wallet.deployContract({ ...artifact('OfflineVault'), args: [account.address, token, account.address] }) });
    const vault = vaultReceipt.contractAddress!;
    await client.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: vault, abi: artifact('OfflineVault').abi, functionName: 'setOperator', args: [account.address] }) });
    await client.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: token, abi: tokenArtifact.abi, functionName: 'mint', args: [account.address, 1_000_000_000_000n] }) });
    return { process: child, rpc, vault, token, close: () => { child.kill(); } };
  } catch (error) { child.kill(); throw error; }
}
export async function runLocalDemo(): Promise<void> {
  const local = await startLocalChain();
  // Explicitly local-only credentials; never overwrite backend/.env or P1 deployment records.
  const snippet = `CHAIN_MODE=chain\nCHAIN_ID=31337\nRPC_URL=${local.rpc}\nVAULT_ADDRESS=${local.vault}\nUSDC_ADDRESS=${local.token}\nISSUER_PRIVATE_KEY=${localRelayerKey}\nRELAYER_PRIVATE_KEY=${localRelayerKey}\nDB_PATH=./offline-pay-local.sqlite\n`;
  writeFileSync(new URL('../.env.local-chain', import.meta.url), snippet, { mode: 0o600 });
  console.log(`Hardhat ready: ${local.rpc}\nOfflineVault=${local.vault}\nMockUSDC=${local.token}\nLocal snippet: backend/.env.local-chain`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { local.close(); process.exit(0); });
}
