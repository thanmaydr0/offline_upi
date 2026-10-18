import type { Hex } from '@offline-pay/shared';
import { z } from 'zod';
import type { ApiClient, LedgerService, ReceivedStore, VoucherWallet } from '../services/types';
import type { LocalStore } from '../api/storage';
import { historyItemSchema, integerSchema, moneySchema, payoutSchema, settlementSchema } from '../api/schemas';

const snapshotSchema = z.object({ wallet: z.record(z.string(), moneySchema), offlinePaise: moneySchema,
  history: z.array(historyItemSchema), payouts: z.array(payoutSchema), lastSync: integerSchema });
export type Snapshot = z.infer<typeof snapshotSchema>;
export type SyncState = { running: boolean; error: string | null; snapshot: Snapshot | null };
type Dependencies = { api: ApiClient; ledger: LedgerService; received: ReceivedStore; wallet: VoucherWallet;
  store: LocalStore; reconcile?: (head: { hash: Hex; counter: bigint }) => Promise<boolean> };

export class SyncEngine {
  private flight?: Promise<void>;
  private listeners = new Set<() => void>();
  private state: SyncState = { running: false, error: null, snapshot: null };
  constructor(private readonly deps: Dependencies) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getState = () => this.state;
  private update(patch: Partial<SyncState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(fn => fn()); }
  async hydrate() {
    const snapshot = await this.deps.store.read('snapshot', snapshotSchema);
    if (snapshot && (!this.state.snapshot || snapshot.lastSync > this.state.snapshot.lastSync)) this.update({ snapshot });
  }
  run = (): Promise<void> => {
    if (this.flight) return this.flight;
    this.flight = this.perform().finally(() => { this.flight = undefined; });
    return this.flight;
  };
  private async perform() {
    this.update({ running: true, error: null });
    try {
      await this.deps.api.getConfig();
      const head = await this.deps.ledger.head();
      const witness = await this.deps.api.postLedgerHead(head);
      if (!witness.ok || witness.flagged) throw new Error('Server flagged this ledger. Offline payments are blocked.');
      if (this.deps.reconcile && !await this.deps.reconcile(head)) throw new Error('Ledger changed during sync. Retry to verify it.');
      const journal = await this.deps.store.read('settlement', settlementSchema);
      let hadFailures = journal?.results.some(result => result.status !== 0) ?? false;
      if (journal) await this.applyResults(journal.results);
      const pending = await this.deps.received.pending();
      // Bound each batch below the backend's JSON body limit, while draining every queued proof.
      for (let offset = 0; offset < pending.length; offset += 16) {
        const batch = pending.slice(offset, offset + 16);
        // Backend redemption is idempotent by voucherId; persist the entire response before local acknowledgement.
        // Never turn a partial/malformed response into a successful settlement.
        const response = settlementSchema.parse(await this.deps.api.settle(batch));
        const expected = new Set(batch.map(item => item.voucher.voucherId.toLowerCase()));
        const actual = response.results.map(item => item.voucherId.toLowerCase());
        if (new Set(actual).size !== actual.length || actual.length !== expected.size || actual.some(id => !expected.has(id))) {
          throw new Error('Incomplete settlement response. Pending proofs are retained for retry.');
        }
        await this.deps.store.write('settlement', response);
        hadFailures ||= response.results.some(result => result.status !== 0);
        await this.applyResults(response.results);
      }
      const [wallet, offlinePaise, history, payouts] = await Promise.all([
        this.deps.api.getWallet(), this.deps.wallet.offlineBalancePaise(), this.deps.api.history(), this.deps.api.payouts(),
      ]);
      const snapshot = snapshotSchema.parse({ wallet, offlinePaise, history, payouts, lastSync: Date.now() });
      await this.deps.store.write('snapshot', snapshot);
      this.update({ snapshot });
      if (hadFailures) throw new Error('Some received vouchers failed settlement. Review Pending for individual results.');
    } catch (error) {
      this.update({ error: error instanceof Error ? error.message : 'Sync failed. Pending proofs remain on this device.' });
    } finally { this.update({ running: false }); }
  }
  private async applyResults(results: { voucherId: Hex; status: number }[]) {
    const pending = new Set((await this.deps.received.pending()).map(item => item.voucher.voucherId.toLowerCase()));
    for (const result of results) {
      if (pending.has(result.voucherId.toLowerCase())) await this.deps.received.markSettled(result.voucherId, result.status);
    }
    await this.deps.store.remove('settlement');
  }
  async idle() { await this.flight; }
}
