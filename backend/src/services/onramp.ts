import { Router } from 'express';
import { createPublicClient, http, parseEventLogs, parseAbiItem, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { AppContext } from '../context.js';
import { OnrampMoneyGateway, onrampNotificationSchema } from '../gateways/onramp.js';
import { HttpError, parse } from '../http.js';

const transfer = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
type Inbox = { provider_id: number; order_id: string; created_at: number };

/** Convert provider decimal INR without binary floating-point money arithmetic. */
export function decimalPaise(input: string | number): bigint {
  const text = String(input);
  if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,2})?$/.test(text)) throw new Error('Invalid provider INR amount');
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
}

export class OnrampService {
  private running = false;
  constructor(private readonly context: AppContext) {
    context.db.exec(`CREATE TABLE IF NOT EXISTS onramp_receipts (
      provider_id INTEGER PRIMARY KEY,
      order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
      state TEXT NOT NULL CHECK(state IN ('queued','funding','done','review')),
      transaction_hash TEXT UNIQUE,
      received_usdc TEXT,
      reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
  }

  routes(): Router {
    const router = Router();
    router.post('/v1/webhooks/onramp', (request, response) => {
      const { gateway, db, env } = this.context;
      if (env.FIAT_GATEWAY !== 'onramp' || !(gateway instanceof OnrampMoneyGateway)) throw new HttpError(404, 'NOT_FOUND', 'Onramp is not enabled.');
      if (!gateway.verifyNotification(request.get('x-onramp-payload') ?? '', request.get('x-onramp-signature') ?? '')) {
        throw new HttpError(401, 'BAD_WEBHOOK_SIGNATURE', 'Onramp webhook authentication failed.');
      }
      const notification = parse(onrampNotificationSchema, request.body as unknown);
      const order = db.prepare('SELECT id FROM orders WHERE id = ?').get(notification.merchantRecognitionId);
      if (!order) throw new HttpError(404, 'ORDER_NOT_FOUND', 'Unknown merchant recognition ID.');
      const previous = db.prepare('SELECT order_id FROM onramp_receipts WHERE provider_id = ?').get(notification.orderId) as { order_id: string } | undefined;
      if (previous && previous.order_id !== notification.merchantRecognitionId) throw new HttpError(409, 'PROVIDER_ORDER_CONFLICT', 'Provider order is already linked.');
      const linked = db.prepare('SELECT provider_id FROM onramp_receipts WHERE order_id = ?').get(notification.merchantRecognitionId) as { provider_id: number } | undefined;
      if (linked && linked.provider_id !== notification.orderId) throw new HttpError(409, 'ORDER_ALREADY_LINKED', 'Merchant order is already linked.');
      const now = Math.floor(Date.now() / 1000);
      db.prepare("INSERT OR IGNORE INTO onramp_receipts(provider_id, order_id, state, created_at, updated_at) VALUES (?, ?, 'queued', ?, ?)")
        .run(notification.orderId, notification.merchantRecognitionId, now, now);
      // Durable acknowledgment before RPC/API calls; Onramp expects <5 seconds.
      response.status(202).json({ accepted: true, replayed: Boolean(previous) });
    });
    return router;
  }

  async processPending(): Promise<void> {
    if (this.running || !(this.context.gateway instanceof OnrampMoneyGateway)) return;
    this.running = true;
    try {
      const rows = this.context.db.prepare("SELECT provider_id, order_id, created_at FROM onramp_receipts WHERE state = 'queued' ORDER BY created_at LIMIT 10").all() as Inbox[];
      for (const row of rows) {
        try { await this.reconcile(row); }
        catch {
          // API outages, unconfirmed receipts and uncertain transactions stay queued.
          // Funding failures are separately placed in review and never auto-retried.
          this.context.db.prepare("UPDATE onramp_receipts SET reason = 'verification_pending', updated_at = ? WHERE provider_id = ? AND state = 'queued'")
            .run(Math.floor(Date.now() / 1000), row.provider_id);
        }
      }
    } finally { this.running = false; }
  }

  private review(id: number, reason: string) {
    this.context.db.prepare("UPDATE onramp_receipts SET state = 'review', reason = ?, updated_at = ? WHERE provider_id = ?")
      .run(reason, Math.floor(Date.now() / 1000), id);
  }

  private async reconcile(row: Inbox) {
    const { env, db, gateway, chain } = this.context;
    if (!(gateway instanceof OnrampMoneyGateway)) return;
    gateway.requireLiveConfiguration();
    const order = db.prepare('SELECT o.amount_inr_paise, o.status, o.created_at, d.address FROM orders o JOIN devices d ON d.id = o.device_id WHERE o.id = ?')
      .get(row.order_id) as { amount_inr_paise: number; status: string; created_at: number; address: Address };
    const tx = await gateway.findTransaction(row.provider_id, new Date((order.created_at - 300) * 1000).toISOString());
    const recipient = privateKeyToAccount(env.RELAYER_PRIVATE_KEY as Hex).address;
    if (tx.merchantRecognitionId !== row.order_id || tx.walletAddress.toLowerCase() !== recipient.toLowerCase() ||
        tx.coinId !== env.ONRAMP_COIN_ID || tx.chainId !== env.ONRAMP_CHAIN_ID || tx.fiatType !== 1 ||
        decimalPaise(tx.fiatAmount) !== BigInt(order.amount_inr_paise)) {
      this.review(row.provider_id, 'provider_details_mismatch'); return;
    }
    if ([-4, -3, -2, -1].includes(tx.status)) {
      db.prepare("UPDATE orders SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'pending'").run(Math.floor(Date.now() / 1000), row.order_id);
      this.review(row.provider_id, 'provider_failed'); return;
    }
    if (![4, 5, 15, 16].includes(tx.status)) return;
    if (!/^0x[0-9a-fA-F]{64}$/.test(tx.transactionHash)) { this.review(row.provider_id, 'invalid_transaction_hash'); return; }
    const client = createPublicClient({ transport: http(env.RPC_URL) });
    if (await client.getChainId() !== env.CHAIN_ID) { this.review(row.provider_id, 'rpc_chain_mismatch'); return; }
    const receipt = await client.getTransactionReceipt({ hash: tx.transactionHash as Hex });
    if (receipt.status !== 'success') { this.review(row.provider_id, 'withdrawal_reverted'); return; }
    // Finalized block is required as well as twelve confirmations (especially on L2s).
    const finalized = await client.getBlock({ blockTag: 'finalized' });
    if (finalized.number === null || finalized.number < receipt.blockNumber || await client.getBlockNumber() < receipt.blockNumber + 11n) return;
    const events = parseEventLogs({ abi: [transfer], logs: receipt.logs, eventName: 'Transfer' });
    const received = events.filter(event => event.address.toLowerCase() === env.USDC_ADDRESS.toLowerCase() && event.args.to.toLowerCase() === recipient.toLowerCase())
      .reduce((sum, event) => sum + event.args.value, 0n);
    const required = (BigInt(order.amount_inr_paise) * 10000n + BigInt(env.INR_PER_USDC) - 1n) / BigInt(env.INR_PER_USDC);
    if (received < required) { this.review(row.provider_id, 'net_usdc_below_required_collateral'); return; }
    const reserve = db.transaction(() => {
      // Unique hash prevents crediting the same withdrawal to another merchant order.
      db.prepare("UPDATE onramp_receipts SET transaction_hash = ?, received_usdc = ?, state = 'funding', updated_at = ? WHERE provider_id = ? AND state = 'queued'")
        .run(tx.transactionHash.toLowerCase(), received.toString(), Math.floor(Date.now() / 1000), row.provider_id);
      const result = db.prepare("UPDATE orders SET status = 'processing', updated_at = ? WHERE id = ? AND status = 'pending'")
        .run(Math.floor(Date.now() / 1000), row.order_id);
      if (result.changes !== 1) throw new Error('Order already processed');
    });
    reserve();
    try {
      await chain.fundCollateral(order.address, required);
      db.transaction(() => {
        db.prepare("UPDATE orders SET status = 'funded', funded_usdc_amount = ?, updated_at = ? WHERE id = ?")
          .run(required.toString(), Math.floor(Date.now() / 1000), row.order_id);
        db.prepare("UPDATE onramp_receipts SET state = 'done', reason = NULL, updated_at = ? WHERE provider_id = ?")
          .run(Math.floor(Date.now() / 1000), row.provider_id);
      })();
    } catch {
      // The existing chain API has no stable funding idempotency key. A crash or
      // uncertain broadcast requires reconciliation, never a second funding call.
      this.review(row.provider_id, 'funding_outcome_uncertain');
    }
  }
}
