import { formatEther } from 'viem';
import { loadEnv } from '../src/env.js';
import { createDatabase } from '../src/db/database.js';
import { RealChain, vaultAbi } from '../src/chain/real/index.js';

const env = loadEnv();
const db = createDatabase(':memory:');
try {
  const chain = new RealChain(env, db);
  const [balance, operator, issuer] = await Promise.all([
    chain.publicClient.getBalance({ address: chain.account.address }),
    chain.publicClient.readContract({ address: chain.vault, abi: vaultAbi, functionName: 'operator' }),
    chain.publicClient.readContract({ address: chain.vault, abi: vaultAbi, functionName: 'issuer' }),
  ]);
  console.log(JSON.stringify({ chainId: await chain.publicClient.getChainId(), relayer: chain.account.address, balanceETH: formatEther(balance), operator, issuer }));
} finally { db.close(); }
