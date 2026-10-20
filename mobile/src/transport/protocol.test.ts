import { describe, expect, test } from '@jest/globals';
import { encodePayload, splitFrames } from '@offline-pay/shared';
import { privateKeyToAccount } from 'viem/accounts';
import { inviteQr, parseInvite, signConnection, verifyConnection, signReceipt, verifyReceipt, type LocalInvite } from './protocol';

const key = `0x${'11'.repeat(32)}` as const;
const wrongKey = `0x${'22'.repeat(32)}` as const;
const invite: LocalInvite = { v: 1, receiptAddress: privateKeyToAccount(key).address,
  request: { v: 1, reqId: `0x${'33'.repeat(16)}`, payee: privateKeyToAccount(wrongKey).address,
    inrPaise: 12500, chainId: 84532, ts: 1900000000 } };
const frames = splitFrames(encodePayload({ proof: 'x'.repeat(2000) }), 1200);

describe('local radio protocol', () => {
  test('authenticates the receiver before spending and rejects replayed connection challenges', async () => {
    const challenge = `0x${'44'.repeat(16)}`;
    const ready = await signConnection(invite, challenge, key);
    await expect(verifyConnection(invite, challenge, ready)).resolves.toBeUndefined();
    await expect(verifyConnection(invite, `0x${'55'.repeat(16)}`, ready)).rejects.toThrow();
    await expect(verifyConnection(invite, challenge, await signConnection(invite, challenge, wrongKey))).rejects.toThrow();
  });
  test('QR carries recipient, amount and receipt verification key without a backend URL', () => {
    const qr = inviteQr(invite);
    expect(qr.length).toBeLessThan(1200);
    expect(parseInvite(qr)).toEqual(invite);
    expect(() => parseInvite('upi://pay?pa=someone@bank')).toThrow();
  });
  test('accepts a signed receipt for exactly the paid request and full proof', async () => {
    const receipt = await signReceipt(invite, frames, key);
    await expect(verifyReceipt(invite, frames, receipt)).resolves.toBeUndefined();
    await expect(verifyReceipt(invite, [...frames].reverse(), receipt)).resolves.toBeUndefined();
  });
  test('rejects forged acknowledgements, changed amounts, recipients and proof content', async () => {
    const receipt = await signReceipt(invite, frames, key);
    await expect(signReceipt(invite, frames, wrongKey)).rejects.toThrow('session key');
    await expect(verifyReceipt({ ...invite, request: { ...invite.request, inrPaise: 1 } }, frames, receipt)).rejects.toThrow();
    await expect(verifyReceipt({ ...invite, request: { ...invite.request, payee: privateKeyToAccount(key).address } }, frames, receipt)).rejects.toThrow();
    await expect(verifyReceipt(invite, [encodePayload('different proof')], receipt)).rejects.toThrow();
    await expect(verifyReceipt(invite, frames, JSON.stringify({ received: true }))).rejects.toThrow();
  });
  test('never confirms an incomplete frame set', async () => {
    const receipt = await signReceipt(invite, frames, key);
    await expect(verifyReceipt(invite, frames.slice(0, 1), receipt)).rejects.toThrow();
  });
});
