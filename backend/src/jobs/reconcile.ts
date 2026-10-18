import { deploymentBlock } from '../chain/deployment.js';
import type { AppContext } from '../context.js';
import { RealChain, vaultAbi } from '../chain/real/index.js';
import { SettlementService } from '../routes/settle-service.js';
import { logger } from '../logger.js';

export class ReconciliationJob {
  private running = false;
  constructor(readonly context: AppContext, readonly settlements: SettlementService) {
    context.db.exec('CREATE TABLE IF NOT EXISTS chain_cursors (scope TEXT PRIMARY KEY, block TEXT NOT NULL); CREATE TABLE IF NOT EXISTS redeemed_events (scope TEXT, voucher_id TEXT, payee TEXT, tx_hash TEXT, block TEXT, PRIMARY KEY(scope, voucher_id));');
  }
  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const { chain, db } = this.context;
      if (chain instanceof RealChain) {
        const scope = `${chain.env.CHAIN_ID}:${chain.vault.toLowerCase()}`;
        const cursor = db.prepare('SELECT block FROM chain_cursors WHERE scope = ?').get(scope) as { block: string } | undefined;
        const height = await chain.publicClient.getBlockNumber();
        // Keep two blocks behind the tip on live networks. Hardhat mines deterministically.
        const end = chain.env.CHAIN_ID === 31337 ? height : height > 2n ? height - 2n : 0n;
        for (let from = cursor ? BigInt(cursor.block) + 1n : deploymentBlock(chain.env); from <= end; from += 200n) {
          const to = from + 199n < end ? from + 199n : end;
          const logs = await chain.publicClient.getContractEvents({ address: chain.vault, abi: vaultAbi, eventName: 'Redeemed', fromBlock: from, toBlock: to });
          for (const log of logs) {
            const args = log.args as unknown as { voucherId: string; payee: string };
            db.prepare('INSERT OR IGNORE INTO redeemed_events VALUES (?, ?, ?, ?, ?)').run(scope, args.voucherId.toLowerCase(), args.payee.toLowerCase(), log.transactionHash, log.blockNumber.toString());
          }
          await this.settlements.recover();
          db.prepare('INSERT OR REPLACE INTO chain_cursors VALUES (?, ?)').run(scope, to.toString());
        }
      }
      await this.settlements.recover();
      if (chain instanceof RealChain) {
        const requests = db.prepare("SELECT w.device_id, w.amount, w.recipient, w.status, d.address, d.revoked_at FROM collateral_withdrawals w JOIN devices d ON d.id = w.device_id WHERE w.status IN ('requesting', 'pending')").all() as { device_id: string; amount: string; recipient: `0x${string}`; status: string; address: `0x${string}`; revoked_at: number | null }[];
        for (const row of requests) {
          if (row.revoked_at !== null) continue;
          if (row.status === 'requesting') {
            await chain.requestWithdraw(row.address, BigInt(row.amount));
            db.prepare("UPDATE collateral_withdrawals SET status = 'pending' WHERE device_id = ?").run(row.device_id);
          }
          const [amount, unlockAt] = await chain.publicClient.readContract({ address: chain.vault, abi: vaultAbi, functionName: 'pendingWithdraw', args: [row.address] }) as [bigint, bigint];
          const block = await chain.publicClient.getBlock();
          if (amount > 0n && block.timestamp >= unlockAt) {
            await chain.executeWithdraw(row.address, row.recipient);
            db.prepare("UPDATE collateral_withdrawals SET status = 'executed' WHERE device_id = ?").run(row.device_id);
          }
        }
      }
      // Retry on-chain freezes after transient RPC failures, including process restarts.
      for (const device of db.prepare('SELECT address FROM devices WHERE revoked_at IS NOT NULL').all() as { address: `0x${string}` }[]) await chain.freeze(device.address);
    } finally { this.running = false; }
  }
  start(intervalMs = 3000): () => void {
    const tick = () => { void this.run().catch(error => logger.error({ event: 'reconciliation_failed', error: error instanceof Error ? error.name : 'unknown' })); };
    tick();
    const timer = setInterval(tick, intervalMs); timer.unref();
    return () => clearInterval(timer);
  }
}
