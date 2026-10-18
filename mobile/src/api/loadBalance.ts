import { z } from 'zod';
import type { StoredVoucher } from '@offline-pay/shared';
import type { ApiClient, LedgerService, ReceivedStore, VoucherWallet } from '../services/types';
import type { LocalStore } from './storage';
import { integerSchema, storedVoucherSchema } from './schemas';

export const loadJournalSchema = z.object({ amountInr: integerSchema.positive(), orderId: z.string().min(1),
  paymentUrl: z.string().min(1), items: z.array(storedVoucherSchema).optional(), complete: z.boolean().default(false) });
export type LoadJournal = z.infer<typeof loadJournalSchema>;
export type LoadPhase = 'idle' | 'kyc' | 'creating' | 'payment' | 'polling' | 'issuing' | 'saving' | 'success' | 'cancelled' | 'failed';
export type LoadState = { phase: LoadPhase; journal: LoadJournal | null; error: string | null };
type Dependencies = { api: ApiClient; wallet: VoucherWallet; ledger: LedgerService; received: ReceivedStore;
  store: LocalStore; openPayment: (url: string) => Promise<'cancel' | 'opened'>; newAttemptId: () => string;
  sleep?: (ms: number) => Promise<void>; timeoutMs?: number; now?: () => number; acceptMockPaid?: boolean };

export class LoadBalanceFlow {
  private flight?: Promise<void>;
  private cancelled = false;
  private listeners = new Set<() => void>();
  private state: LoadState = { phase: 'idle', journal: null, error: null };
  constructor(private readonly deps: Dependencies) {}
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  getState = () => this.state;
  private update(patch: Partial<LoadState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(fn => fn()); }
  async hydrate() {
    if (this.flight) return;
    const journal = await this.deps.store.read('load', loadJournalSchema);
    if (!this.flight) this.update({ journal, phase: journal?.complete ? 'success' : 'idle' });
  }
  start = (amountInr: number): Promise<void> => this.launch(amountInr, true);
  resume = (openPayment = false): Promise<void> => this.launch(undefined, openPayment);
  cancel = () => { this.cancelled = true; this.update({ phase: 'cancelled', error: 'Paused. Your order is retained; resume to check payment.' }); };
  private launch(amountInr: number | undefined, openPayment: boolean): Promise<void> {
    if (this.flight) return this.flight;
    this.cancelled = false;
    this.flight = this.perform(amountInr, openPayment).finally(() => { this.flight = undefined; });
    return this.flight;
  }
  private async waitFor(check: () => Promise<boolean>, timeout: number) {
    const now = this.deps.now ?? Date.now;
    const deadline = now() + timeout;
    while (!this.cancelled) {
      if (await check()) return;
      if (now() >= deadline) throw new Error('Timed out. Resume this order to check its status.');
      await (this.deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(1500);
    }
    throw new Error('Paused. Resume this order when ready.');
  }
  private async perform(amountInr: number | undefined, openPayment: boolean) {
    this.update({ error: null });
    try {
      let journal = await this.deps.store.read('load', loadJournalSchema);
      if (journal?.complete) { this.update({ phase: 'success', journal }); return; }
      if (!journal) {
        const attemptSchema = z.object({ amountInr: integerSchema.positive(), attemptId: z.string().uuid() });
        let attempt = await this.deps.store.read('load-attempt', attemptSchema);
        if (amountInr === undefined && !attempt) { this.update({ phase: 'idle' }); return; }
        amountInr = attempt?.amountInr ?? amountInr;
        integerSchema.positive().parse(amountInr);
        if (amountInr === undefined) throw new Error('Choose an amount to load.');
        if (!Number.isSafeInteger(amountInr * 100)) throw new Error('Amount is too large.');
        this.update({ phase: 'kyc' });
        const kycStatus = await this.deps.api.kycStatus();
        // Hosted Onramp checkout performs real KYC before accepting payment.
        if (kycStatus !== 'provider_required') {
          if (kycStatus !== 'approved') await this.deps.api.startKyc();
          await this.waitFor(async () => {
            const status = await this.deps.api.kycStatus();
            if (['rejected', 'failed'].includes(status)) throw new Error('Identity check was rejected.');
            return status === 'approved' || status === 'provider_required';
          }, 60000);
        }
        if (this.cancelled) return;
        this.update({ phase: 'creating' });
        if (!attempt) {
          attempt = attemptSchema.parse({ amountInr, attemptId: this.deps.newAttemptId() });
          await this.deps.store.write('load-attempt', attempt);
        }
        const order = await this.deps.api.createOnramp(attempt.amountInr, attempt.attemptId);
        journal = loadJournalSchema.parse({ amountInr, ...order, complete: false });
        // Persist orderId before launching a browser or asking the user to pay.
        await this.deps.store.write('load', journal);
        await this.deps.store.remove('load-attempt');
      }
      this.update({ journal });
      if (this.cancelled) return;
      if (!journal.items) {
        const initialStatus = await this.deps.api.onrampStatus(journal.orderId);
        if (initialStatus === 'review') throw new Error('Payment needs review. Your order is retained; contact support before paying again.');
        if (['failed', 'cancelled', 'expired'].includes(initialStatus)) throw new Error(`Order ${initialStatus}. No vouchers were added.`);
        if (!['funded', 'issued'].includes(initialStatus) && openPayment) {
          this.update({ phase: 'payment' });
          const result = await this.deps.openPayment(journal.paymentUrl);
          if (result === 'cancel') {
            const status = await this.deps.api.onrampStatus(journal.orderId);
            if (!['paid', 'funded', 'issued'].includes(status)) { this.cancel(); return; }
          }
        }
        this.update({ phase: 'polling' });
        const orderId = journal.orderId;
        await this.waitFor(async () => {
          const status = await this.deps.api.onrampStatus(orderId);
          if (status === 'review') throw new Error('Payment needs review. Your order is retained; contact support before paying again.');
          if (['failed', 'cancelled', 'expired'].includes(status)) throw new Error(`Order ${status}. No vouchers were added.`);
          // Real backend waits for funded collateral; mock services return paid.
          return ['funded', 'issued', ...(this.deps.acceptMockPaid ? ['paid'] : [])].includes(status);
        }, this.deps.timeoutMs ?? 180000);
        if (this.cancelled) return;
        this.update({ phase: 'issuing' });
        const items: StoredVoucher[] = await this.deps.api.issueVouchers(orderId);
        journal = { ...journal, items };
        await this.deps.store.write('load', journal);
      }
      this.update({ phase: 'saving', journal });
      if (!journal.items?.length || journal.items.reduce((sum, item) => sum + BigInt(item.voucher.inrPaise), 0n) !== BigInt(journal.amountInr) * 100n) {
        throw new Error('Issued vouchers do not match the paid amount. Order and returned vouchers retained for recovery.');
      }
      const missing: StoredVoucher[] = [];
      for (const item of journal.items ?? []) {
        if (!await this.deps.received.seenVoucher(item.voucher.voucherId)) missing.push(item);
      }
      if (missing.length) await this.deps.wallet.addIssued(missing);
      // Kind contains orderId because LedgerService's public entry type only exposes kind.
      // Rechecking list recovers a process death after append but before journal completion.
      const kind = `load:${journal.orderId}`;
      if (!(await this.deps.ledger.list()).some(entry => entry.kind === kind)) await this.deps.ledger.append({ kind });
      journal = { ...journal, complete: true };
      await this.deps.store.write('load', journal);
      this.update({ phase: 'success', journal });
    } catch (error) {
      this.update({ phase: this.cancelled ? 'cancelled' : 'failed', error: error instanceof Error ? error.message : 'Could not load balance. Resume to retry.' });
    }
  }
  async acknowledgeSuccess() {
    if (this.flight) await this.flight;
    const journal = await this.deps.store.read('load', loadJournalSchema);
    if (!journal?.complete) return;
    await this.deps.store.remove('load');
    this.update({ phase: 'idle', journal: null, error: null });
  }
  async discardTerminalOrder() {
    if (this.flight) return;
    const journal = await this.deps.store.read('load', loadJournalSchema);
    if (!journal || journal.items || journal.complete) return;
    const status = await this.deps.api.onrampStatus(journal.orderId);
    if (!['failed', 'cancelled', 'expired'].includes(status)) throw new Error('Order is still active. Resume it to avoid paying twice.');
    await this.deps.store.remove('load');
    this.update({ phase: 'idle', journal: null, error: null });
  }
  async idle() { await this.flight; }
}
