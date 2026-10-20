import { randomUUID } from 'node:crypto';
import { paymentProofSchema, verifyProofItem, type ProofItem } from '@offline-pay/shared';
import { z } from 'zod';
import type { Address } from 'viem';
import type { AppContext } from '../context.js';
import type { AuthContext } from '../auth.js';
import type { RedeemResult } from '../chain/types.js';
import { RealChain, stringify } from '../chain/real/index.js';
import { HttpError } from '../http.js';
import { logger } from '../logger.js';

const uint = z.union([z.string().regex(/^(0|[1-9][0-9]{0,77})$/), z.number().int().nonnegative().safe(), z.bigint().nonnegative()]).transform(BigInt);
const wireItem = z.object({
  voucher: z.object({ voucherId: z.string(), device: z.string(), usdcAmount: uint, inrPaise: z.number().int().positive(), expiry: uint }).strict(),
  payment: z.object({ voucherId: z.string(), device: z.string(), payee: z.string(), usdcAmount: uint, deadline: uint }).strict(),
  issuerSig: z.string().regex(/^0x[0-9a-fA-F]{130}$/), deviceSig: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
}).strict();
export const settlementSchema = z.object({ items: z.array(wireItem).min(1).max(100) }).strict().transform(body => {
  const proof = paymentProofSchema.parse({ v: 1, reqId: `0x${'0'.repeat(32)}`, items: body.items });
  return { items: proof.items as ProofItem[] };
});
type Stored = { id: string; settlement_id: string; voucher_id: string; payee_id: string; proof: string; status: number | null; payout_id: string | null };
export class SettlementService {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly context: AppContext) {
    context.db.exec(`CREATE TABLE IF NOT EXISTS settlement_requests (id TEXT PRIMARY KEY, payee_id TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS settlement_proofs (id TEXT PRIMARY KEY, settlement_id TEXT NOT NULL, voucher_id TEXT NOT NULL, payee_id TEXT NOT NULL, deadline TEXT NOT NULL, proof TEXT NOT NULL, status INTEGER, payout_id TEXT, UNIQUE(voucher_id, payee_id, deadline));
      CREATE TABLE IF NOT EXISTS collateral_withdrawals (device_id TEXT PRIMARY KEY, amount TEXT NOT NULL, recipient TEXT NOT NULL, status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS payee_online_balances (device_id TEXT PRIMARY KEY, inr_paise INTEGER NOT NULL DEFAULT 0);`);
    context.db.exec('CREATE TABLE IF NOT EXISTS settlement_request_items (request_id TEXT, proof_id TEXT, PRIMARY KEY(request_id, proof_id))');
  }
  private serialize<T>(work: () => Promise<T>): Promise<T> { const next = this.tail.then(work); this.tail = next.catch(() => undefined); return next; }
  async settle(auth: AuthContext, items: ProofItem[]) {
    return this.serialize(async () => {
      const { db, env } = this.context;
      // First verify the entire submission, including replays. No untrusted proof reaches RPC writes.
      const revoked = new Set((db.prepare('SELECT address FROM devices WHERE revoked_at IS NOT NULL').all() as { address: string }[]).map(row => row.address.toLowerCase()));
      const unique = new Map<string, ProofItem>();
      const incoming = new Set(items.map(item => item.voucher.voucherId.toLowerCase()));
      const received = db.prepare("SELECT voucher_id, inr_paise FROM received_items WHERE payee_device_id = ? AND status = 'pending'").all(auth.deviceId) as { voucher_id: string; inr_paise: number }[];
      const unsettled = received.filter(row => !incoming.has(row.voucher_id.toLowerCase())).reduce((sum, row) => sum + BigInt(row.inr_paise), 0n);
      let total = 0n;
      for (const item of items) {
        const id = item.voucher.voucherId.toLowerCase();
        if (unique.has(id)) {
          if (stringify(unique.get(id)) !== stringify(item)) throw new HttpError(400, 'CONFLICTING_DUPLICATE', 'Conflicting payments for one voucher in a batch.');
          continue;
        }
        const result = await verifyProofItem(item, {
          domain: { name: 'OfflineVault', version: '1', chainId: env.CHAIN_ID, verifyingContract: env.VAULT_ADDRESS as Address },
          issuerAddress: this.context.issuerAddress, payeeAddress: auth.deviceAddress,
          request: { v: 1, payee: auth.deviceAddress, inrPaise: item.voucher.inrPaise, reqId: `0x${'0'.repeat(32)}`, chainId: env.CHAIN_ID, ts: Math.floor(Date.now()/1000) },
          nowSeconds: BigInt(Math.floor(Date.now()/1000)), clockSkewSeconds: 0n, revokedDevices: revoked, seenVoucherIds: new Set(),
          maxSinglePaymentPaise: BigInt(env.MAX_SINGLE_OFFLINE_PAYMENT_PAISE), maxUnsettledPaise: BigInt(env.MERCHANT_MAX_UNSETTLED_PAISE), pendingUnsettledPaise: unsettled + total,
        });
        if (!result.ok) throw new HttpError(400, 'INVALID_PROOF', result.reason);
        total += result.totalInrPaise;
        if (total > BigInt(env.MAX_SINGLE_OFFLINE_PAYMENT_PAISE)) throw new HttpError(400, 'PAYMENT_LIMIT', 'Settlement exceeds per-payment cap.');
        unique.set(id, item);
      }
      // Offline receipt verification/redemption is independent of payout setup.
      // payout() safely waits for a VPA and recover() submits it after one is saved.
      const settlementId = randomUUID();
      db.prepare('INSERT INTO settlement_requests VALUES (?, ?, ?)').run(settlementId, auth.deviceId, Math.floor(Date.now()/1000));
      const results: RedeemResult[] = [];
      const pending: { row: Stored; item: ProofItem }[] = [];
      for (const [id, item] of unique) {
        const prior = db.prepare('SELECT * FROM settlement_proofs WHERE voucher_id = ? AND payee_id = ? AND deadline = ?').get(id, auth.deviceId, item.payment.deadline.toString()) as Stored | undefined;
        if (prior && prior.proof !== stringify(item)) throw new HttpError(409, 'PROOF_CHANGED', 'An idempotent retry must contain the same proof.');
        const receivedItem = db.prepare('SELECT id FROM received_items WHERE lower(voucher_id) = ? AND payee_device_id = ?').get(id, auth.deviceId) as { id: string } | undefined;
        if (!receivedItem) {
          const receivedStatus = prior?.status === 0 ? 'settled' : prior?.status != null ? 'rejected' : 'pending';
          db.prepare('INSERT INTO received_items (id, payee_device_id, voucher_id, payer_device_address, inr_paise, proof_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(randomUUID(), auth.deviceId, id, item.voucher.device.toLowerCase(), item.voucher.inrPaise, stringify(item), receivedStatus, Math.floor(Date.now() / 1000));
        }
        if (prior?.status !== null && prior?.status !== undefined) {
          results.push({ voucherId: id, status: prior.status as RedeemResult['status'] });
          await this.payout(prior);
          continue;
        }
        const row: Stored = prior ?? { id: randomUUID(), settlement_id: settlementId, voucher_id: id, payee_id: auth.deviceId, proof: stringify(item), status: null, payout_id: null };
        if (!prior) db.prepare('INSERT INTO settlement_proofs (id, settlement_id, voucher_id, payee_id, deadline, proof) VALUES (?, ?, ?, ?, ?, ?)').run(row.id, row.settlement_id, id, auth.deviceId, item.payment.deadline.toString(), row.proof);
        db.prepare('INSERT OR IGNORE INTO settlement_request_items VALUES (?, ?)').run(settlementId, row.id);
        pending.push({ row, item });
      }
      for (let offset = 0; offset < pending.length; offset += 20) {
        const chunk = pending.slice(offset, offset + 20);
        const batch = chunk.map(entry => entry.item);
        const statuses = this.context.chain instanceof RealChain ? await this.context.chain.redeemBatch(batch, chunk.map(entry => entry.row.id).join(':')) : await this.context.chain.redeemBatch(batch);
        for (let i = 0; i < chunk.length; i++) {
          const { row, item } = chunk[i];
          const result = statuses[i];
          await this.record(row, item, result.status);
          results.push(result);
        }
      }
      // Link retries to this request too, without changing proof ownership.
      for (const item of unique.values()) {
        const row = db.prepare('SELECT id FROM settlement_proofs WHERE voucher_id = ? AND payee_id = ? AND deadline = ?').get(item.voucher.voucherId.toLowerCase(), auth.deviceId, item.payment.deadline.toString()) as { id: string };
        db.prepare('INSERT OR IGNORE INTO settlement_request_items VALUES (?, ?)').run(settlementId, row.id);
      }
      return { settlementId, results };
    });
  }
  async record(row: Stored, item: ProofItem, status: number): Promise<void> {
    const { db, chain } = this.context;
    if (status === 1) {
      const winner = db.prepare('SELECT proof FROM settlement_proofs WHERE voucher_id = ? AND status = 0 LIMIT 1').get(row.voucher_id) as { proof: string } | undefined;
      const winnerProof = winner ? settlementSchema.parse({ items: [JSON.parse(winner.proof)] }).items[0] : undefined;
      const historical = !winnerProof && chain instanceof RealChain ? await chain.findRedemption(item.voucher.voucherId) : undefined;
      const payment = winnerProof?.payment ?? historical;
      if (payment && (payment.payee.toLowerCase() !== item.payment.payee.toLowerCase() || payment.deadline !== item.payment.deadline)) {
        const payer = db.prepare('SELECT id FROM devices WHERE lower(address) = ?').get(item.voucher.device.toLowerCase()) as { id: string } | undefined;
        const now = Math.floor(Date.now()/1000);
        db.transaction(() => {
          if (payer) db.prepare('UPDATE devices SET frozen = 1, revoked_at = COALESCE(revoked_at, ?) WHERE id = ?').run(now, payer.id);
          if (!db.prepare('SELECT id FROM double_spend_attempts WHERE voucher_id = ? AND reason = ?').get(row.voucher_id, row.id)) {
            db.prepare('INSERT INTO double_spend_attempts VALUES (?, ?, ?, ?, ?)').run(randomUUID(), payer?.id ?? null, row.voucher_id, row.id, now);
            db.prepare('INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)').run(randomUUID(), row.payee_id, 'double_spend_attempt', row.voucher_id, stringify({ device: item.voucher.device, original: payment, attempted: item.payment }), now);
          }
        })();
        await chain.freeze(item.voucher.device);
      }
    }
    db.prepare('UPDATE settlement_proofs SET status = ? WHERE id = ?').run(status, row.id);
    row.status = status;
    const payer = db.prepare('SELECT id FROM devices WHERE lower(address) = ?').get(item.voucher.device.toLowerCase()) as { id: string } | undefined;
    if (payer && !db.prepare('SELECT id FROM settlement_items WHERE id = ?').get(row.id)) db.prepare('INSERT INTO settlement_items VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(row.id, row.settlement_id, row.voucher_id, payer.id, row.payee_id, item.voucher.inrPaise, status, Math.floor(Date.now()/1000));
    if (status === 0) {
      db.prepare("UPDATE vouchers SET status = 'settled' WHERE lower(voucher_id) = ?").run(row.voucher_id);
      db.prepare("UPDATE received_items SET status = 'settled' WHERE lower(voucher_id) = ? AND payee_device_id = ? AND status = 'pending'").run(row.voucher_id, row.payee_id);
      await this.payout(row);
    } else {
      db.prepare("UPDATE received_items SET status = 'rejected' WHERE lower(voucher_id) = ? AND payee_device_id = ? AND status = 'pending'").run(row.voucher_id, row.payee_id);
    }
  }
  async payout(row: Stored): Promise<void> {
    if (row.status !== 0) return;
    const { db, gateway } = this.context;
    const item = settlementSchema.parse({ items: [JSON.parse(row.proof)] }).items[0];
    const payee = db.prepare('SELECT user_id, payee_vpa FROM devices WHERE id = ?').get(row.payee_id) as { user_id: string; payee_vpa: string | null };
    if (!payee.payee_vpa) return;
    // Fee hook: integer paise only. Zero until an explicitly configured fee policy exists.
    const feePaise = 0;
    const amount = item.voucher.inrPaise - feePaise;
    const id = row.payout_id ?? row.id;
    const now = Math.floor(Date.now()/1000);
    db.transaction(() => {
      db.prepare('UPDATE settlement_proofs SET payout_id = ? WHERE id = ?').run(id, row.id);
      db.prepare("INSERT OR IGNORE INTO payouts VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, ?)").run(id, payee.user_id, row.payee_id, amount, payee.payee_vpa, now, now);
    })();
    const existing = db.prepare('SELECT status, gateway_reference FROM payouts WHERE id = ?').get(id) as { status: string; gateway_reference: string | null };
    if (!existing.gateway_reference) {
      // FiatGateway implementations must honor payoutId as their provider idempotency key.
      try {
        const result = await gateway.createPayout({ payoutId: id, amountInrPaise: amount, vpa: payee.payee_vpa });
        db.prepare('UPDATE payouts SET gateway_reference = ?, status = ?, updated_at = ? WHERE id = ?').run(result.reference, result.status, now, id);
      } catch {
        // Redemption already succeeded. Retain a durable pending payout for retry,
        // without returning a false settlement failure or claiming fiat was paid.
        logger.warn({ event: 'payout_submission_pending', payoutId: id });
      }
    }
  }
  async recover(): Promise<void> {
    return this.serialize(async () => {
      const rows = this.context.db.prepare('SELECT * FROM settlement_proofs WHERE status IS NULL').all() as Stored[];
      for (const row of rows) {
        const item = settlementSchema.parse({ items: [JSON.parse(row.proof)] }).items[0];
        const chain = this.context.chain;
        if (!(chain instanceof RealChain)) continue;
        const found = await chain.findRedemption(item.voucher.voucherId);
        if (found) await this.record(row, item, found.payee.toLowerCase() === item.payment.payee.toLowerCase() && found.deadline === item.payment.deadline ? 0 : 1);
      }
      for (const row of this.context.db.prepare('SELECT * FROM settlement_proofs WHERE status = 0').all() as Stored[]) await this.payout(row);
      this.completeMockPayouts();
    });
  }
  completeMockPayouts(): void {
    if (this.context.env.FIAT_GATEWAY !== 'mock') return;
    const { db } = this.context;
    const now = Math.floor(Date.now()/1000);
    db.transaction(() => {
      const rows = db.prepare("SELECT id, device_id, amount_inr_paise FROM payouts WHERE status = 'pending' AND gateway_reference LIKE 'mock-%' AND created_at <= ?").all(now - 1) as { id: string; device_id: string; amount_inr_paise: number }[];
      for (const row of rows) {
        db.prepare("UPDATE payouts SET status = 'paid', updated_at = ? WHERE id = ? AND status = 'pending'").run(now, row.id);
        db.prepare('INSERT INTO payee_online_balances VALUES (?, ?) ON CONFLICT(device_id) DO UPDATE SET inr_paise = inr_paise + excluded.inr_paise').run(row.device_id, row.amount_inr_paise);
      }
    })();
  }
}
