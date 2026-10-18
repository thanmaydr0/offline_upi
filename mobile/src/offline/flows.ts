import {
  decodePayload, encodePayload, paymentProofSchema, reassembleFrames, splitFrames, verifyProof,
  type Address, type Hex, type PaymentRequest, type RiskLabel, type VerifyResult,
} from '@offline-pay/shared';
import { getAddress, isAddress } from 'viem';
import { z } from 'zod';
import type { KeyService, LedgerService, OfflineFlows, ReceivedStore, VoucherWallet } from '../services/types';

export const REQUEST_TTL_SECONDS = 300;
export const MAX_FRAME_CHARS = 1800;
export const MAX_PROOF_CHARS = 128_000;
export const MAX_FRAMES = 128;
const address = z.string().refine((value) => isAddress(value, { strict: true }), 'Invalid address checksum')
  .transform((value) => getAddress(value));
const paise = z.number().int().positive().safe().max(0xffff_ffff);
const reqId = z.string().regex(/^0x[\da-fA-F]{32}$/).transform((value) => value.toLowerCase() as Hex);
export const requestSchema = z.object({
  v: z.literal(1), payee: address, inrPaise: paise, reqId,
  chainId: z.number().int().positive().safe(), ts: z.number().int().nonnegative().safe(),
  name: z.string().trim().min(1).max(80).refine((value) => !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)).optional(),
}).strict();
export const configSchema = z.object({
  chainId: z.number().int().positive().safe(), issuerAddress: address, vaultAddress: address,
  revokedDevices: z.array(address).max(100_000),
  limits: z.object({ maxSingleOfflinePaymentPaise: paise, merchantMaxUnsettledPaise: paise }),
  clockSkewSeconds: z.number().int().min(0).max(300).default(300),
  paymentDeadlineSeconds: z.number().int().positive().max(604_800).default(604_800),
});
const openSchema = z.object({ request: requestSchema, expiresAt: z.number().int().safe() }).strict();
const paidSchema = z.object({ reqId, state: z.literal('committed') }).strict();
const boundedProofSchema = paymentProofSchema.extend({ items: paymentProofSchema.shape.items.max(128) });

export interface FlowStorage {
  get(key: string): Promise<unknown | null>;
  set(key: string, value: unknown): Promise<void>;
}
export type FlowDependencies = {
  keys: KeyService; wallet: VoucherWallet; ledger: LedgerService; received: ReceivedStore;
  storage: FlowStorage; cachedConfig(): Promise<unknown>; nowSeconds(): Promise<number>;
  randomBytes(count: number): Promise<Uint8Array>;
  assertClockHealthy(): Promise<void>;
  /** Core's markSpent already writes offline_spend. Other wallet adapters may leave this false. */
  walletAppendsSpendLedger?: boolean;
};

export function formatOfflineInr(value: bigint | number): string {
  const amount = BigInt(value);
  return `₹${(amount / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${(amount % 100n).toString().padStart(2, '0')}`;
}

/** Exposure labels describe cached, local risk only; they cannot detect another offline payee's spends. */
export function exposureRisk(exposure: bigint, cap: bigint): RiskLabel {
  if (exposure * 100n > cap * 90n) return 'high';
  return exposure * 4n > cap * 3n ? 'medium' : 'low';
}

export class OfflineFlowController implements OfflineFlows {
  private queue: Promise<void> = Promise.resolve();
  private frames = new Map<number, string>();
  private frameCount = 0;
  private frameChars = 0;
  private blockedRequests = new Set<string>();
  constructor(private readonly deps: FlowDependencies) {}

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  resetFrames(): void {
    this.frames.clear(); this.frameCount = 0; this.frameChars = 0;
  }

  private async context() {
    await this.deps.assertClockHealthy();
    const config = configSchema.parse(await this.deps.cachedConfig());
    const me: Address = address.parse(await this.deps.keys.getAddress());
    const now = z.number().int().nonnegative().safe().parse(await this.deps.nowSeconds());
    return { config, me, now };
  }

  private async validateRequest(input: unknown) {
    const request = requestSchema.parse(input);
    const context = await this.context();
    if (request.chainId !== context.config.chainId) throw new Error('Wrong chain. This request uses another network.');
    if (request.inrPaise > context.config.limits.maxSingleOfflinePaymentPaise) throw new Error('Amount exceeds the offline payment limit.');
    if (request.ts > context.now + 30) throw new Error('Request timestamp is in the future.');
    if (context.now >= request.ts + REQUEST_TTL_SECONDS) throw new Error('Request expired. Ask for a new QR.');
    if (request.payee === context.me) throw new Error('You cannot pay your own request.');
    if (this.blockedRequests.has(request.reqId) || await this.deps.storage.get(`paid:${request.reqId}`) !== null) {
      throw new Error('This request was already paid or committed. A second proof is refused.');
    }
    return { request, ...context };
  }

  /** Purely local scan validation; does not reserve money or trigger authentication. */
  async parseRequestQr(value: unknown): Promise<PaymentRequest> {
    const qr = z.string().min(7).max(MAX_FRAME_CHARS).regex(/^OPAY1:[A-Za-z0-9_-]+$/).parse(value);
    try { return (await this.validateRequest(decodePayload<unknown>(qr))).request; }
    catch (error) { throw new Error(error instanceof Error ? error.message : 'Malformed request CBOR.'); }
  }

  async previewRequest(input: unknown): Promise<{ request: PaymentRequest; balanceAfterPaise: bigint }> {
    const { request } = await this.validateRequest(input);
    const balanceAfterPaise = await this.deps.wallet.offlineBalancePaise() - BigInt(request.inrPaise);
    if (balanceAfterPaise < 0n) throw new Error('Insufficient offline balance.');
    return { request, balanceAfterPaise };
  }

  createRequest(inrPaise: number): Promise<PaymentRequest> {
    return this.exclusive(async () => {
      const amount = paise.parse(inrPaise);
      const { me, config, now } = await this.context();
      if (amount > config.limits.maxSingleOfflinePaymentPaise) throw new Error('Amount exceeds the offline payment limit.');
      const random = await this.deps.randomBytes(16);
      if (random.length !== 16) throw new Error('Secure randomness unavailable.');
      const request = requestSchema.parse({ v: 1, payee: me, inrPaise: amount,
        reqId: `0x${Array.from(random, (byte) => byte.toString(16).padStart(2, '0')).join('')}`,
        chainId: config.chainId, ts: now });
      await this.deps.storage.set('open', { request, expiresAt: now + REQUEST_TTL_SECONDS });
      this.resetFrames();
      return request;
    });
  }

  async getOpenRequest(): Promise<PaymentRequest | null> {
    const stored = await this.deps.storage.get('open');
    if (stored === null) return null;
    const open = openSchema.parse(stored);
    if (await this.deps.nowSeconds() >= open.expiresAt) return null;
    return open.request;
  }

  payRequest(input: PaymentRequest): Promise<string[]> {
    return this.exclusive(async () => {
      const { request, config, me, now } = await this.validateRequest(input);
      let selected;
      try { selected = await this.deps.wallet.selectForAmount(request.inrPaise); }
      catch (error) {
        if (!(error instanceof Error) || error.name !== 'ExactChangeError') throw error;
        throw await this.exactChangeError();
      }
      if (!selected) throw await this.exactChangeError();
      if (selected.length === 0 || selected.length > 128 || selected.reduce((sum, item) => sum + BigInt(item.voucher.inrPaise), 0n) !== BigInt(request.inrPaise)) {
        throw new Error('Wallet returned an invalid exact-change selection.');
      }
      const payments = selected.map(({ voucher }) => ({
        voucherId: voucher.voucherId, device: me, payee: request.payee, usdcAmount: voucher.usdcAmount,
        deadline: voucher.expiry < BigInt(now + config.paymentDeadlineSeconds) ? voucher.expiry : BigInt(now + config.paymentDeadlineSeconds),
      }));
      // One batch call is the only biometric gate, irrespective of the number of vouchers.
      const signatures = await this.deps.keys.signPayments(payments, `Pay ${formatOfflineInr(request.inrPaise)} offline`);
      if (signatures.length !== selected.length) throw new Error('Signing did not return every voucher signature.');
      const proof = boundedProofSchema.parse({ v: 1, reqId: request.reqId,
        items: selected.map(({ voucher, issuerSig }, index) => ({ voucher, issuerSig, payment: payments[index], deviceSig: signatures[index] })) });
      // Verify our output before burning vouchers, including cached revocation and domain checks.
      const checked = await verifyProof(proof, {
        domain: { name: 'OfflineVault', version: '1', chainId: config.chainId, verifyingContract: config.vaultAddress },
        request, payeeAddress: request.payee, issuerAddress: config.issuerAddress, nowSeconds: BigInt(now), clockSkewSeconds: 0n,
        revokedDevices: new Set(config.revokedDevices.map((value) => value.toLowerCase())), seenVoucherIds: new Set(),
        maxSinglePaymentPaise: BigInt(config.limits.maxSingleOfflinePaymentPaise),
        maxUnsettledPaise: BigInt(config.limits.maxSingleOfflinePaymentPaise), pendingUnsettledPaise: 0n,
      });
      if (!checked.ok) throw new Error(`Cannot create proof: ${checked.reason}`);
      const encoded = encodePayload(proof);
      if (encoded.length > MAX_PROOF_CHARS) throw new Error('Proof too large. Use fewer vouchers.');
      const frames = splitFrames(encoded, MAX_FRAME_CHARS);
      if (frames.length > MAX_FRAMES) throw new Error('Too many proof frames.');
      // Revalidate after the potentially slow biometric prompt, before committing any spend.
      await this.validateRequest(request);
      // Fail closed across restarts and partial failures: never regenerate a committed request.
      this.blockedRequests.add(request.reqId);
      await this.deps.storage.set(`paid:${request.reqId}`, paidSchema.parse({ reqId: request.reqId, state: 'committed' }));
      await this.deps.wallet.markSpent(selected.map((item) => item.voucher.voucherId), request.reqId);
      if (!this.deps.walletAppendsSpendLedger) {
        const entry = { kind: 'offline_spend', reqId: request.reqId,
          voucherIds: selected.map((item) => item.voucher.voucherId), inrPaise: request.inrPaise, spentAtMs: now * 1000 };
        await this.deps.ledger.append(entry);
      }
      return frames;
    });
  }

  private async exactChangeError(): Promise<Error> {
    const available = await this.deps.wallet.list();
    const counts = new Map<number, number>();
    for (const { voucher } of available) counts.set(voucher.inrPaise, (counts.get(voucher.inrPaise) ?? 0) + 1);
    const notes = [...counts].sort(([a], [b]) => a - b).map(([amount, count]) => `${count} × ${formatOfflineInr(amount)}`).join(', ');
    return new Error(`Exact change is impossible. Denominations you hold: ${notes || 'none'}. Request another amount.`);
  }

  receiveFrame(input: string): Promise<VerifyResult | { progress: number }> {
    return this.exclusive(async () => {
      try {
        const { config, me, now } = await this.context();
        const stored = await this.deps.storage.get('open');
        if (stored === null) throw new Error('No open request. Create a new QR.');
        const { request, expiresAt } = openSchema.parse(stored);
        if (now >= expiresAt || now >= request.ts + REQUEST_TTL_SECONDS) throw new Error('Request expired. Create a new QR.');
        const frame = z.string().min(7).max(MAX_FRAME_CHARS).parse(input);
        if (!frame.startsWith('OPAY1:')) throw new Error('Not an OfflinePay QR.');
        const match = /^OPAY1:([1-9]\d{0,2})\/([1-9]\d{0,2}):([A-Za-z0-9_-]+)$/.exec(frame);
        let encoded = frame;
        if (match) {
          const index = Number(match[1]); const total = Number(match[2]);
          if (total < 2 || total > MAX_FRAMES || index > total || (this.frameCount !== 0 && total !== this.frameCount)) throw new Error('Invalid or mixed proof frames. Restart scanning.');
          const old = this.frames.get(index);
          if (old !== undefined && old !== frame) throw new Error('Conflicting duplicate frame. Restart scanning.');
          if (old === undefined) { this.frames.set(index, frame); this.frameChars += match[3].length; }
          this.frameCount = total;
          if (this.frameChars + 6 > MAX_PROOF_CHARS) throw new Error('Proof exceeds size limit.');
          if (this.frames.size < total) return { progress: this.frames.size / total };
          encoded = reassembleFrames([...this.frames.values()]);
        } else {
          if (!/^OPAY1:[A-Za-z0-9_-]+$/.test(frame)) throw new Error('Invalid proof QR.');
          if (this.frames.size) throw new Error('Cannot mix a complete QR and proof frames. Restart scanning.');
        }
        const proof = boundedProofSchema.parse(decodePayload<unknown>(encoded));
        const seenVoucherIds = new Set<string>();
        for (const item of proof.items) {
          if (await this.deps.received.seenVoucher(item.voucher.voucherId)) seenVoucherIds.add(item.voucher.voucherId.toLowerCase());
        }
        const pending = await this.deps.received.pending();
        const pendingUnsettledPaise = pending.reduce((sum, item) => sum + BigInt(item.voucher.inrPaise), 0n);
        const maxSinglePaymentPaise = BigInt(config.limits.maxSingleOfflinePaymentPaise);
        if (BigInt(request.inrPaise) > maxSinglePaymentPaise) throw new Error('Payment exceeds the offline limit.');
        const maxUnsettledPaise = BigInt(config.limits.merchantMaxUnsettledPaise);
        const result = await verifyProof(proof, {
          domain: { name: 'OfflineVault', version: '1', chainId: config.chainId, verifyingContract: config.vaultAddress },
          request, issuerAddress: config.issuerAddress, payeeAddress: me, nowSeconds: BigInt(now),
          clockSkewSeconds: BigInt(config.clockSkewSeconds),
          revokedDevices: new Set(config.revokedDevices.map((value) => value.toLowerCase())), seenVoucherIds,
          maxSinglePaymentPaise, maxUnsettledPaise, pendingUnsettledPaise,
        });
        this.resetFrames();
        if (!result.ok) return result;
        // Re-check expiry after signature verification and pending-store reads.
        if (await this.deps.nowSeconds() >= expiresAt) throw new Error('Request expired during verification.');
        await this.deps.received.addVerified(proof);
        await this.deps.storage.set('open', null);
        return { ...result, risk: exposureRisk(pendingUnsettledPaise + result.totalInrPaise, maxUnsettledPaise) };
      } catch (error) {
        this.resetFrames();
        return { ok: false, risk: 'high', reason: error instanceof Error ? error.message : 'Malformed proof QR.' };
      }
    });
  }
}
