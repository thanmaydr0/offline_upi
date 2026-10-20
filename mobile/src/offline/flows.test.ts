import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { privateKeyToAccount } from 'viem/accounts';
import {
  decodePayload, encodePayload, reassembleFrames, splitFrames, PAYMENT_TYPES, VOUCHER_TYPES,
  type Hex, type LedgerEntry, type Payment, type PaymentProof, type ProofItem, type StoredVoucher, type VerifyResult,
} from '@offline-pay/shared';
import { exposureRisk, formatOfflineInr, MAX_FRAME_CHARS, OfflineFlowController, type FlowDependencies } from './flows';

// Public deterministic test keys, never used outside these in-memory fixtures.
const issuer = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const payer = privateKeyToAccount(`0x${'22'.repeat(32)}`);
const payee = privateKeyToAccount(`0x${'33'.repeat(32)}`);
const vault = '0x0000000000000000000000000000000000008453' as const;
const domain = { name: 'OfflineVault' as const, version: '1' as const, chainId: 84532, verifyingContract: vault };
let now = 1_900_000_000;
let id = 0;
const fetchGuard = () => { throw new Error('Network access is forbidden in airplane-mode tests'); };

async function instance(account: typeof payer, denominations: number[] = []) {
  const config = { chainId: domain.chainId, issuerAddress: issuer.address, vaultAddress: vault, revokedDevices: [] as string[],
    limits: { maxSingleOfflinePaymentPaise: 200_000, merchantMaxUnsettledPaise: 1_000_000 } };
  const storage = new Map<string, unknown>();
  let notes: StoredVoucher[] = [];
  for (const amount of denominations) {
    const voucher = { voucherId: `0x${(++id).toString(16).padStart(64, '0')}` as Hex, device: account.address,
      usdcAmount: BigInt(amount) * 100n, inrPaise: amount, expiry: BigInt(now + 604_800) };
    notes.push({ voucher, issuerSig: await issuer.signTypedData({ domain, types: VOUCHER_TYPES, primaryType: 'Voucher', message: voucher }) });
  }
  const pending: ProofItem[] = [];
  const seen = new Set<string>();
  const events: string[] = [];
  const deps: FlowDependencies = {
    cachedConfig: async () => config, nowSeconds: async () => now,
    assertClockHealthy: async () => undefined, randomBytes: async (count) => globalThis.crypto.getRandomValues(new Uint8Array(count)),
    storage: { get: async (key) => storage.get(key) ?? null, set: async (key, value) => { storage.set(key, structuredClone(value)); } },
    keys: { init: async () => ({ address: account.address }), getAddress: async () => account.address,
      integrity: async () => ({ rooted: false, isDevice: true }),
      signPayments: jest.fn(async (payments: Payment[]) => {
        events.push('sign');
        return Promise.all(payments.map((message) => account.signTypedData({ domain, types: PAYMENT_TYPES, primaryType: 'Payment', message })));
      }),
    },
    wallet: {
      list: async () => notes, addIssued: async (items) => { notes.push(...items); },
      offlineBalancePaise: async () => notes.reduce((sum, item) => sum + BigInt(item.voucher.inrPaise), 0n),
      selectForAmount: async (amount) => {
        for (let mask = 1; mask < (1 << notes.length); mask++) {
          const choice = notes.filter((_, index) => mask & (1 << index));
          if (choice.reduce((sum, item) => sum + BigInt(item.voucher.inrPaise), 0n) === BigInt(amount)) return choice;
        }
        return null;
      },
      markSpent: jest.fn(async (ids: Hex[]) => { events.push('spent'); notes = notes.filter((item) => !ids.includes(item.voucher.voucherId)); }),
    },
    ledger: { append: jest.fn(async (entry: Omit<LedgerEntry, 'hash' | 'previousHash' | 'counter'>) => { events.push('ledger'); return { ...entry, hash: `0x${'aa'.repeat(32)}` as Hex,
      previousHash: `0x${'00'.repeat(32)}` as Hex, counter: 1n }; }),
      head: async () => ({ hash: `0x${'aa'.repeat(32)}` as Hex, counter: 1n }), list: async () => [], verifyChain: async () => ({ ok: true }) },
    received: { pending: async () => pending, seenVoucher: async (voucherId) => seen.has(voucherId.toLowerCase()),
      addVerified: jest.fn(async (proof: PaymentProof) => {
        if (proof.items.some((item) => seen.has(item.voucher.voucherId.toLowerCase()))) throw new Error('duplicate');
        pending.push(...proof.items);
        proof.items.forEach((item) => seen.add(item.voucher.voucherId.toLowerCase()));
      }), markSettled: async () => undefined },
  };
  return { flow: new OfflineFlowController(deps), deps, config, storage, pending, seen, events };
}
async function receive(flow: OfflineFlowController, frames: string[]) {
  let result: VerifyResult | { progress: number } = { progress: 0 };
  for (const frame of frames) result = await flow.receiveFrame(frame);
  return result;
}
async function transaction(denominations = [100, 200, 500]) {
  const sender = await instance(payer, denominations);
  const receiver = await instance(payee);
  const request = await receiver.flow.createRequest(denominations.reduce((sum, amount) => sum + amount, 0));
  const frames = await sender.flow.payRequest(request);
  return { sender, receiver, request, frames };
}
beforeEach(() => { now = 1_900_000_000; jest.spyOn(globalThis, 'fetch').mockImplementation(fetchGuard); });
afterEach(() => { expect(globalThis.fetch).not.toHaveBeenCalled(); jest.restoreAllMocks(); });

describe('two offline devices with real shared CBOR and EIP-712 helpers', () => {
  test('request, preview, one batch approval, durable spending, unordered frames and received storage', async () => {
    const sender = await instance(payer, [100, 200, 500]);
    const receiver = await instance(payee);
    const request = await receiver.flow.createRequest(800);
    expect(request.reqId).toMatch(/^0x[0-9a-f]{32}$/);
    expect(receiver.storage.get('open')).toEqual({ request, expiresAt: now + 300 });
    const parsed = await sender.flow.parseRequestQr(encodePayload(request));
    expect(await sender.flow.previewRequest(parsed)).toMatchObject({ balanceAfterPaise: 0n });
    const frames = await sender.flow.payRequest(parsed);
    expect(sender.deps.keys.signPayments).toHaveBeenCalledTimes(1);
    expect(sender.events).toEqual(['sign', 'spent', 'ledger']);
    expect(await sender.deps.wallet.offlineBalancePaise()).toBe(0n);
    expect(frames.length).toBeGreaterThan(1);
    const progress = await receiver.flow.receiveFrame(frames[frames.length - 1]);
    expect(progress).toHaveProperty('progress');
    expect(await receiver.flow.receiveFrame(frames[frames.length - 1])).toEqual(progress);
    expect(await receive(receiver.flow, [...frames].reverse().slice(1))).toEqual({ ok: true, risk: 'low', totalInrPaise: 800n });
    expect(receiver.pending).toHaveLength(3);
    expect(receiver.pending.reduce((sum, item) => sum + BigInt(item.voucher.inrPaise), 0n)).toBe(800n);
    expect(await receiver.flow.getOpenRequest()).toBeNull();
  });
  test('rejects a tampered signed field after reassembling valid CBOR', async () => {
    const { receiver, frames } = await transaction();
    const proof = decodePayload<PaymentProof>(reassembleFrames(frames));
    proof.items[0].voucher.inrPaise += 1;
    expect(await receive(receiver.flow, splitFrames(encodePayload(proof), MAX_FRAME_CHARS))).toMatchObject({ ok: false, reason: 'invalid_issuer_signature' });
    expect(receiver.pending).toHaveLength(0);
  });
  test('tampered frame never credits funds, original frames can be scanned again', async () => {
    const { receiver, frames } = await transaction();
    const corrupted = [...frames];
    corrupted[0] = corrupted[0].slice(0, -1) + (corrupted[0].endsWith('A') ? 'B' : 'A');
    expect(await receive(receiver.flow, corrupted)).toMatchObject({ ok: false });
    expect(receiver.pending).toHaveLength(0);
    expect(await receive(receiver.flow, frames)).toMatchObject({ ok: true });
  });
  test('duplicate-frame conflicts reset assembly', async () => {
    const { receiver, frames } = await transaction();
    await receiver.flow.receiveFrame(frames[0]);
    const conflict = frames[0].slice(0, -1) + (frames[0].endsWith('A') ? 'B' : 'A');
    expect(await receiver.flow.receiveFrame(conflict)).toMatchObject({ ok: false, reason: expect.stringContaining('duplicate') });
    expect(await receive(receiver.flow, frames)).toMatchObject({ ok: true });
  });
  test('refuses a second proof for the same request, also after payer restart', async () => {
    const { sender, request } = await transaction();
    await expect(sender.flow.payRequest(request)).rejects.toThrow('second proof');
    await expect(new OfflineFlowController(sender.deps).payRequest(request)).rejects.toThrow('second proof');
    expect(sender.deps.keys.signPayments).toHaveBeenCalledTimes(1);
  });
  test('receiver rejects replay, including against a restored open request', async () => {
    const { receiver, request, frames } = await transaction();
    expect(await receive(receiver.flow, frames)).toMatchObject({ ok: true });
    expect(await receive(receiver.flow, frames)).toMatchObject({ ok: false });
    receiver.storage.set('open', { request, expiresAt: now + 300 });
    expect(await receive(new OfflineFlowController(receiver.deps), frames)).toMatchObject({ ok: false, reason: 'duplicate_voucher' });
    expect(receiver.pending).toHaveLength(3);
  });
  test('only one of two simultaneous pay attempts succeeds', async () => {
    const sender = await instance(payer, [100, 100]); const receiver = await instance(payee);
    const request = await receiver.flow.createRequest(100);
    const results = await Promise.allSettled([sender.flow.payRequest(request), sender.flow.payRequest(request)]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(sender.deps.keys.signPayments).toHaveBeenCalledTimes(1);
  });
  test('expired request at exactly five minutes fails at payer and payee', async () => {
    const { sender, receiver, request, frames } = await transaction();
    now += 300;
    await expect(sender.flow.parseRequestQr(encodePayload(request))).rejects.toThrow('expired');
    expect(await receive(receiver.flow, frames)).toMatchObject({ ok: false, reason: expect.stringContaining('expired') });
    expect(await receiver.flow.getOpenRequest()).toBeNull();
  });
  test('expiry during authentication does not burn vouchers or expose proof', async () => {
    const sender = await instance(payer, [100]); const receiver = await instance(payee);
    const request = await receiver.flow.createRequest(100);
    const sign = sender.deps.keys.signPayments;
    sender.deps.keys.signPayments = async (payments, reason) => { const signatures = await sign(payments, reason); now += 300; return signatures; };
    await expect(sender.flow.payRequest(request)).rejects.toThrow('expired');
    expect(sender.deps.wallet.markSpent).not.toHaveBeenCalled();
  });
  test('impossible exact change lists the denominations held', async () => {
    const sender = await instance(payer, [200, 500]); const receiver = await instance(payee);
    await expect(sender.flow.payRequest(await receiver.flow.createRequest(100))).rejects.toThrow('1 × ₹2.00, 1 × ₹5.00');
    expect(sender.deps.keys.signPayments).not.toHaveBeenCalled();
  });
  test('failed ledger leaves vouchers spent and forbids regenerating the proof', async () => {
    const sender = await instance(payer, [100]); const receiver = await instance(payee);
    const request = await receiver.flow.createRequest(100);
    sender.deps.ledger.append = async () => { throw new Error('ledger storage failed'); };
    await expect(sender.flow.payRequest(request)).rejects.toThrow('ledger storage failed');
    expect(await sender.deps.wallet.offlineBalancePaise()).toBe(0n);
    await expect(new OfflineFlowController(sender.deps).payRequest(request)).rejects.toThrow('second proof');
  });
  test('biometric cancellation leaves wallet and request available for another attempt', async () => {
    const sender = await instance(payer, [100]); const receiver = await instance(payee);
    const request = await receiver.flow.createRequest(100); const sign = sender.deps.keys.signPayments;
    sender.deps.keys.signPayments = async () => { throw new Error('cancelled'); };
    await expect(sender.flow.payRequest(request)).rejects.toThrow('cancelled');
    expect(sender.deps.wallet.markSpent).not.toHaveBeenCalled();
    sender.deps.keys.signPayments = sign;
    await expect(sender.flow.payRequest(request)).resolves.toHaveProperty('length');
  });
});

describe('hostile input and cached risk policy', () => {
  test.each(['hello', 'OPAY1:_w', 'OPAY1:1/999:AAAA', 'OPAY1:0/2:AAAA', `OPAY1:${'A'.repeat(1800)}`])('rejects invalid QR %s', async (qr) => {
    const sender = await instance(payer); const receiver = await instance(payee);
    await receiver.flow.createRequest(100);
    await expect(sender.flow.parseRequestQr(qr)).rejects.toThrow();
    expect(await receiver.flow.receiveFrame(qr)).toMatchObject({ ok: false });
  });
  test('rejects wrong chain, bad checksum, negative/fractional amount, future timestamp, and self payment', async () => {
    const sender = await instance(payer); const receiver = await instance(payee);
    const request = await receiver.flow.createRequest(100);
    for (const patch of [{ chainId: 8453 }, { payee: '0x52908400098527886E0F7030069857D2E4169Ee7' },
      { inrPaise: -1 }, { inrPaise: 0.1 }, { ts: now + 31 }]) {
      await expect(sender.flow.parseRequestQr(encodePayload({ ...request, ...patch }))).rejects.toThrow();
    }
    await expect(receiver.flow.parseRequestQr(encodePayload(request))).rejects.toThrow('own request');
  });
  test('missing cache and suspicious clock fail closed without a network call', async () => {
    const receiver = await instance(payee);
    receiver.deps.assertClockHealthy = async () => { throw new Error('clock'); };
    await expect(receiver.flow.createRequest(100)).rejects.toThrow('clock');
    receiver.deps.assertClockHealthy = async () => undefined;
    receiver.deps.cachedConfig = async () => null;
    await expect(receiver.flow.createRequest(100)).rejects.toThrow();
  });
  test('rejects revoked payer from cached config', async () => {
    const { receiver, frames } = await transaction(); receiver.config.revokedDevices.push(payer.address);
    expect(await receive(receiver.flow, frames)).toMatchObject({ ok: false, reason: 'device_revoked' });
  });
  test('rejects aggregate single-payment limit even when every voucher is within it', async () => {
    const { receiver, frames } = await transaction(); receiver.config.limits.maxSingleOfflinePaymentPaise = 700;
    expect(await receive(receiver.flow, frames)).toMatchObject({ ok: false, reason: expect.stringContaining('limit') });
  });
  test.each([[750, 'low'], [751, 'medium'], [900, 'medium'], [901, 'high'], [1000, 'high']])('risk threshold %i / 1000 = %s', async (exposure, risk) => {
    const { receiver, frames } = await transaction([100]);
    receiver.config.limits.merchantMaxUnsettledPaise = 1000;
    const proof = decodePayload<PaymentProof>(reassembleFrames(frames));
    receiver.pending.push({ ...proof.items[0], voucher: { ...proof.items[0].voucher, inrPaise: Number(exposure) - 100 } });
    expect(await receive(receiver.flow, frames)).toMatchObject({ ok: true, risk });
    expect(exposureRisk(BigInt(exposure), 1000n)).toBe(risk);
  });
  test('rejects merchant unsettled cap overflow', async () => {
    const { receiver, frames } = await transaction([100]); receiver.config.limits.merchantMaxUnsettledPaise = 99;
    expect(await receive(receiver.flow, frames)).toMatchObject({ ok: false, reason: 'unsettled_limit' });
    expect(receiver.pending).toHaveLength(0);
  });
  test('rejects a proof tied to another request', async () => {
    const { receiver, frames } = await transaction([100]);
    await receiver.flow.createRequest(100);
    expect(await receive(receiver.flow, frames)).toMatchObject({ ok: false, reason: 'request_mismatch' });
  });
  test('rejects a payment signed for a different recipient', async () => {
    const { receiver, frames } = await transaction([100]);
    const proof = decodePayload<PaymentProof>(reassembleFrames(frames));
    proof.items[0].payment.payee = issuer.address;
    proof.items[0].deviceSig = await payer.signTypedData({ domain, types: PAYMENT_TYPES, primaryType: 'Payment', message: proof.items[0].payment });
    expect(await receive(receiver.flow, splitFrames(encodePayload(proof), MAX_FRAME_CHARS))).toMatchObject({ ok: false, reason: 'wrong_payee' });
  });
  test('rejects passed payment deadlines beyond the shared clock-skew allowance', async () => {
    const { receiver, frames } = await transaction([100]);
    const proof = decodePayload<PaymentProof>(reassembleFrames(frames));
    proof.items[0].payment.deadline = BigInt(now - 301);
    proof.items[0].deviceSig = await payer.signTypedData({ domain, types: PAYMENT_TYPES, primaryType: 'Payment', message: proof.items[0].payment });
    expect(await receive(receiver.flow, splitFrames(encodePayload(proof), MAX_FRAME_CHARS))).toMatchObject({ ok: false, reason: 'payment_deadline_passed' });
  });
  test('does not show a successful receipt when ReceivedStore fails', async () => {
    const { receiver, frames } = await transaction([100]);
    receiver.deps.received.addVerified = async () => { throw new Error('disk full'); };
    expect(await receive(receiver.flow, frames)).toMatchObject({ ok: false, reason: 'disk full' });
    expect(receiver.pending).toHaveLength(0);
    expect(await receiver.flow.getOpenRequest()).not.toBeNull();
  });
  test('persists the request marker before handing control to the spending wallet', async () => {
    const sender = await instance(payer, [100]); const receiver = await instance(payee);
    const request = await receiver.flow.createRequest(100);
    sender.deps.wallet.markSpent = async () => {
      expect(sender.storage.has(`paid:${request.reqId}`)).toBe(true);
      throw new Error('interrupted spend');
    };
    await expect(sender.flow.payRequest(request)).rejects.toThrow('interrupted spend');
    await expect(new OfflineFlowController(sender.deps).payRequest(request)).rejects.toThrow('second proof');
  });
  test('restores an open request after restart', async () => {
    const receiver = await instance(payee); const request = await receiver.flow.createRequest(100);
    expect(await new OfflineFlowController(receiver.deps).getOpenRequest()).toEqual(request);
  });
  test('restores the same spent proof after restart without spending again', async () => {
    const { sender, request, frames } = await transaction([100]);
    const restarted = new OfflineFlowController(sender.deps);
    expect(await restarted.getOutgoingPayment()).toMatchObject({ request, frames, ready: true });
    expect(sender.deps.wallet.markSpent).toHaveBeenCalledTimes(1);
    await restarted.acknowledgeOutgoing(request.reqId);
    expect(await restarted.getOutgoingPayment()).toBeNull();
    await expect(restarted.payRequest(request)).rejects.toThrow('second proof');
  });
  test('recovers proof after a committed spend followed by interrupted ledger persistence', async () => {
    const sender = await instance(payer, [100]); const receiver = await instance(payee);
    const request = await receiver.flow.createRequest(100);
    sender.deps.ledger.append = async () => { throw new Error('interrupted'); };
    await expect(sender.flow.payRequest(request)).rejects.toThrow('interrupted');
    const pending = await new OfflineFlowController(sender.deps).getOutgoingPayment();
    expect(pending).not.toBeNull();
    expect(await receive(receiver.flow, pending!.frames)).toMatchObject({ ok: true });
    expect(sender.deps.wallet.markSpent).toHaveBeenCalledTimes(1);
  });
  test('formats paise exactly as INR without floating point', () => {
    expect(formatOfflineInr(105n)).toBe('₹1.05'); expect(formatOfflineInr(200_000)).toBe('₹2,000.00');
  });
});
