import { readFileSync } from 'node:fs';
import { deploymentBlock } from '../deployment.js';
import { createHash, randomUUID } from 'node:crypto';
import { createPublicClient, createWalletClient, defineChain, http, encodeFunctionData, decodeFunctionData, keccak256, parseEventLogs, type Abi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { ProofItem } from '@offline-pay/shared';
import type { BackendEnv } from '../../env.js';
import type { BackendDatabase } from '../../db/database.js';
import type { ChainClient, RedeemResult, RedeemStatus } from '../types.js';

export const vaultAbi = JSON.parse(readFileSync(new URL('../../../../shared/src/abi/OfflineVault.json', import.meta.url), 'utf8')) as Abi;
export const tokenAbi = JSON.parse(readFileSync(new URL('../../../../shared/src/abi/MockUSDC.json', import.meta.url), 'utf8')) as Abi;
export const stringify = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => {
  if (typeof item === 'bigint') return item.toString();
  if (item && typeof item === 'object' && !Array.isArray(item)) return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
  return item;
});

/** One process per relayer key. Signed transactions are journaled before broadcast.
 * The journal contains spend-authorizing transactions: protect it like the wallet. */
export class RealChain implements ChainClient {
  readonly publicClient;
  readonly wallet;
  readonly account;
  readonly vault: Address;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly scope: string;
  constructor(readonly env: BackendEnv, readonly db: BackendDatabase) {
    this.account = privateKeyToAccount(env.RELAYER_PRIVATE_KEY as Hex);
    this.vault = env.VAULT_ADDRESS as Address;
    const chain = defineChain({ id: env.CHAIN_ID, name: 'OfflinePay', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [env.RPC_URL] } } });
    this.publicClient = createPublicClient({ chain, cacheTime: 0, transport: http(env.RPC_URL) });
    this.wallet = createWalletClient({ account: this.account, chain, transport: http(env.RPC_URL) });
    this.scope = `${env.CHAIN_ID}:${this.vault.toLowerCase()}:${this.account.address.toLowerCase()}`;
    db.exec(`CREATE TABLE IF NOT EXISTS relayer_transactions (key TEXT PRIMARY KEY, data TEXT NOT NULL, raw TEXT NOT NULL, hash TEXT NOT NULL, nonce INTEGER NOT NULL, gas_price TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS relayer_transaction_attempts (key TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(key, hash));
      CREATE TABLE IF NOT EXISTS relayer_results (key TEXT PRIMARY KEY, payload TEXT NOT NULL, result TEXT NOT NULL);`);
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.catch(() => undefined);
    return result;
  }
  private async send(key: string, to: Address, data: Hex) {
    if (await this.publicClient.getChainId() !== this.env.CHAIN_ID) throw new Error('RPC chain ID mismatch');
    const journalKey = `${this.scope}:${key}`;
    let row = this.db.prepare('SELECT * FROM relayer_transactions WHERE key = ?').get(journalKey) as { raw: Hex; hash: Hex; nonce: number; gas_price: string; data: string } | undefined;
    if (row && row.data !== `${to}:${data}`) throw new Error('Idempotency key payload mismatch');
    let nextNonce = await this.publicClient.getTransactionCount({ address: this.account.address, blockTag: 'pending' });
    if (!row) {
      const last = this.db.prepare('SELECT key, hash, nonce FROM relayer_transactions WHERE key LIKE ? ORDER BY nonce DESC LIMIT 1').get(`${this.scope}:%`) as { key: string; hash: Hex; nonce: number } | undefined;
      if (last && nextNonce <= last.nonce) {
        const hashes = this.db.prepare('SELECT hash FROM relayer_transaction_attempts WHERE key = ?').all(last.key) as { hash: Hex }[];
        let confirmed = false;
        for (const candidate of [{ hash: last.hash }, ...hashes]) {
          if (await this.publicClient.getTransactionReceipt({ hash: candidate.hash }).catch(() => undefined)) { confirmed = true; break; }
        }
        if (!confirmed) throw new Error('Prior relayer transaction is unresolved; retry its idempotency key first');
        nextNonce = last.nonce + 1;
      }
    }
    const nonce = row?.nonce ?? nextNonce;
    let gasPrice = row ? BigInt(row.gas_price) : await this.publicClient.getGasPrice();
    for (let attempt = 0; attempt < 4; attempt++) {
      const hashes = this.db.prepare('SELECT hash FROM relayer_transaction_attempts WHERE key = ?').all(journalKey) as { hash: Hex }[];
      for (const candidate of hashes) {
        const receipt = await this.publicClient.getTransactionReceipt({ hash: candidate.hash }).catch(() => undefined);
        if (receipt) { if (receipt.status !== 'success') throw new Error('Relayer transaction reverted'); return receipt; }
      }
      if (!row || attempt > 0) {
        if (attempt > 0) gasPrice = gasPrice * 125n / 100n + 1n;
        const gas = await this.publicClient.estimateGas({ account: this.account, to, data });
        const raw = await this.wallet.signTransaction({ to, data, nonce, gas: gas * 120n / 100n, gasPrice, type: 'legacy', chainId: this.env.CHAIN_ID });
        row = { raw, hash: keccak256(raw), nonce, gas_price: gasPrice.toString(), data: `${to}:${data}` };
        this.db.prepare('INSERT OR REPLACE INTO relayer_transactions VALUES (?, ?, ?, ?, ?, ?)').run(journalKey, row.data, raw, row.hash, nonce, row.gas_price);
        this.db.prepare('INSERT OR IGNORE INTO relayer_transaction_attempts VALUES (?, ?)').run(journalKey, row.hash);
      }
      const known = await this.publicClient.getTransactionReceipt({ hash: row.hash }).catch(() => undefined);
      if (known) { if (known.status !== 'success') throw new Error('Relayer transaction reverted'); return known; }
      try { await this.publicClient.sendRawTransaction({ serializedTransaction: row.raw }); } catch { /* An uncertain broadcast must retain its nonce and signed payload. */ }
      try {
        const receipt = await this.publicClient.waitForTransactionReceipt({ hash: row.hash, timeout: 20_000, pollingInterval: 500 });
        if (receipt.status !== 'success') throw new Error('Relayer transaction reverted');
        return receipt;
      } catch (error) { if (attempt === 3) throw error; }
    }
    throw new Error('Transaction retry exhausted');
  }
  async fundCollateral(device: Address, amount: bigint): Promise<void> {
    if (amount <= 0n) throw new RangeError('Positive collateral required');
    return this.serial(async () => {
      const key = randomUUID();
      // Deliberately no auto-mint even on local chain 31337; seed local tokens separately.
      if (this.env.CHAIN_ID === 84532) await this.send(`${key}:mint`, this.env.USDC_ADDRESS as Address, encodeFunctionData({ abi: tokenAbi, functionName: 'mint', args: [this.account.address, amount] }));
      await this.send(`${key}:approve`, this.env.USDC_ADDRESS as Address, encodeFunctionData({ abi: tokenAbi, functionName: 'approve', args: [this.vault, amount] }));
      await this.send(`${key}:fund`, this.vault, encodeFunctionData({ abi: vaultAbi, functionName: 'fundCollateral', args: [device, amount] }));
    });
  }
  async redeemBatch(items: readonly ProofItem[], idempotencyKey?: string): Promise<RedeemResult[]> {
    if (items.length < 1 || items.length > 20) throw new RangeError('Batch size must be 1..20');
    return this.serial(async () => {
      const payload = stringify(items);
      const key = `${this.scope}:settle:${idempotencyKey ?? createHash('sha256').update(payload).digest('hex')}`;
      const prior = this.db.prepare('SELECT * FROM relayer_results WHERE key = ?').get(key) as { payload: string; result: string } | undefined;
      if (prior) { if (prior.payload !== payload) throw new Error('Settlement key payload mismatch'); return JSON.parse(prior.result) as RedeemResult[]; }
      const simulation = await this.publicClient.simulateContract({ account: this.account, address: this.vault, abi: vaultAbi, functionName: 'redeemBatch', args: [items] });
      const statuses = simulation.result as readonly number[];
      const receipt = await this.send(key, this.vault, encodeFunctionData({ abi: vaultAbi, functionName: 'redeemBatch', args: [items] }));
      const logs = parseEventLogs({ abi: vaultAbi, eventName: 'Redeemed', logs: receipt.logs.filter(log => log.address.toLowerCase() === this.vault.toLowerCase()), strict: false });
      const redeemed = new Set(logs.map(log => (log.args as unknown as { voucherId: string }).voucherId.toLowerCase()));
      const results: RedeemResult[] = [];
      for (const [i, item] of items.entries()) {
        // A receipt event is the only authority for OK. Failure codes come from simulation;
        // this ABI emits no per-item failure events, so concurrent state changes are best effort.
        let status = statuses[i] as RedeemStatus;
        if (redeemed.delete(item.voucher.voucherId.toLowerCase())) status = 0;
        else if (status === 0) {
          const post = await this.publicClient.simulateContract({ account: this.account, address: this.vault, abi: vaultAbi, functionName: 'redeemBatch', args: [[item]], blockNumber: receipt.blockNumber });
          status = (post.result as number[])[0] as RedeemStatus;
          if (status === 0) throw new Error('Ambiguous redemption: no matching Redeemed event');
        }
        results.push({ voucherId: item.voucher.voucherId, status });
      }
      this.db.prepare('INSERT INTO relayer_results VALUES (?, ?, ?)').run(key, payload, JSON.stringify(results));
      return results;
    });
  }
  async freeze(device: Address): Promise<void> { await this.serial(() => this.send(`freeze:${device.toLowerCase()}`, this.vault, encodeFunctionData({ abi: vaultAbi, functionName: 'freeze', args: [device] }))); }
  async getCollateral(device: Address): Promise<bigint> { return await this.publicClient.readContract({ address: this.vault, abi: vaultAbi, functionName: 'collateral', args: [device] }) as bigint; }
  async findRedemption(voucherId: Hex): Promise<{ payee: Address; deadline: bigint } | undefined> {
    const height = await this.publicClient.getBlockNumber();
    for (let start = deploymentBlock(this.env); start <= height; start += 200n) {
      const logs = await this.publicClient.getContractEvents({ address: this.vault, abi: vaultAbi, eventName: 'Redeemed', args: { voucherId }, fromBlock: start, toBlock: start + 199n < height ? start + 199n : height });
      for (const log of logs) {
        const tx = await this.publicClient.getTransaction({ hash: log.transactionHash });
        const decoded = decodeFunctionData({ abi: vaultAbi, data: tx.input });
        if (decoded.functionName !== 'redeemBatch') continue;
        const items = decoded.args?.[0] as readonly ProofItem[];
        const match = items.find(item => item.voucher.voucherId.toLowerCase() === voucherId.toLowerCase());
        if (match) return { payee: match.payment.payee, deadline: match.payment.deadline };
      }
    }
  }
  async requestWithdraw(device: Address, amount: bigint): Promise<void> { await this.serial(() => this.send(`withdraw:${device}:${amount}`, this.vault, encodeFunctionData({ abi: vaultAbi, functionName: 'requestWithdraw', args: [device, amount] }))); }
  async executeWithdraw(device: Address, to: Address): Promise<void> { await this.serial(() => this.send(`execute:${device}`, this.vault, encodeFunctionData({ abi: vaultAbi, functionName: 'executeWithdraw', args: [device, to] }))); }
}
