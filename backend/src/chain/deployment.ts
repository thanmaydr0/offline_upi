import type { BackendEnv } from '../env.js';

/** Public deployment metadata; reconciliation must also work from a fresh checkout. */
export function deploymentBlock(env: BackendEnv): bigint {
  if (env.CHAIN_DEPLOYMENT_BLOCK !== undefined) return BigInt(env.CHAIN_DEPLOYMENT_BLOCK);
  if (env.CHAIN_ID === 31337) return 0n;
  if (env.CHAIN_ID === 84532 && env.VAULT_ADDRESS.toLowerCase() === '0x6e69218ac07732c4379fb1c3adc6fc49922c32f0') {
    return 48281257n;
  }
  throw new Error('Set CHAIN_DEPLOYMENT_BLOCK to the configured vault deployment block before reconciliation.');
}
