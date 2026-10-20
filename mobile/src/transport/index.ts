import * as Crypto from 'expo-crypto';
import { decodePayload, reassembleFrames, type Hex, type VerifyResult } from '@offline-pay/shared';
import { privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';
import { offlineFlows, offlineFlowStorage } from '../offline';
import { ensureBluetooth, localLink, type ProofEvent } from './native';
import { frameListSchema, inviteSchema, signConnection, verifyConnection, signReceipt, verifyReceipt, type LocalInvite } from './protocol';

const sessionSchema = z.object({ invite: inviteSchema, key: z.string().regex(/^0x[0-9a-f]{64}$/).transform(value => value as Hex) });
const deliverySchema = z.object({ invite: inviteSchema, peer: z.string() });
export async function receiverInvite(request: LocalInvite['request']): Promise<LocalInvite> {
  const saved = await offlineFlowStorage.get(`radio:${request.reqId}`);
  if (saved) {
    await offlineFlowStorage.set('radio-last-receiver', request.reqId);
    return sessionSchema.parse(saved).invite;
  }
  const bytes = await Crypto.getRandomBytesAsync(32);
  const key = `0x${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}` as Hex;
  bytes.fill(0);
  const invite: LocalInvite = { v: 1, request, receiptAddress: privateKeyToAccount(key).address };
  await offlineFlowStorage.set(`radio:${request.reqId}`, { invite, key });
  await offlineFlowStorage.set('radio-last-receiver', request.reqId);
  return invite;
}
export async function lastReceiverInvite(): Promise<LocalInvite | null> {
  const id = await offlineFlowStorage.get('radio-last-receiver');
  if (typeof id !== 'string') return null;
  const raw = await offlineFlowStorage.get(`radio:${id}`);
  return raw ? sessionSchema.parse(raw).invite : null;
}
let receiveQueue: Promise<unknown> = Promise.resolve();
export function receiveRadioProof(event: ProofEvent): Promise<Extract<VerifyResult, { ok: true }>> {
  const next = receiveQueue.then(() => processRadioProof(event));
  receiveQueue = next.catch(() => undefined);
  return next;
}
async function processRadioProof(event: ProofEvent): Promise<Extract<VerifyResult, { ok: true }>> {
  const saved = sessionSchema.parse(await offlineFlowStorage.get(`radio:${event.session}`));
  const frames = frameListSchema.parse(JSON.parse(event.payload) as unknown);
  const header = z.object({ reqId: z.literal(event.session) }).parse(decodePayload<unknown>(frames.length === 1 ? frames[0] : reassembleFrames(frames)));
  if (header.reqId !== saved.invite.request.reqId) throw new Error('Proof belongs to a different receiving request.');
  // Same verifier and encrypted credit store as the QR path; Bluetooth is only transport.
  offlineFlows.resetFrames();
  let result: VerifyResult | { progress: number } = { progress: 0 };
  for (const frame of frames) {
    result = await offlineFlows.receiveFrame(frame);
    if ('ok' in result && !result.ok) throw new Error(result.reason);
  }
  if (!('ok' in result) || !result.ok) throw new Error('Payment proof is incomplete.');
  // Sign only after addVerified has durably committed the receiver's local credit.
  const receipt = await signReceipt(saved.invite, frames, saved.key);
  await localLink().respond(event.id, receipt);
  return result;
}
export async function startReceiving(reqId: string): Promise<void> {
  await ensureBluetooth();
  await localLink().startReceiver(reqId);
}
export async function answerHello(event: ProofEvent): Promise<void> {
  const saved = sessionSchema.parse(await offlineFlowStorage.get(`radio:${event.session}`));
  await localLink().respond(event.id, await signConnection(saved.invite, event.payload, saved.key));
}
export async function prepareDelivery(invite: LocalInvite, peer: string): Promise<void> {
  await ensureBluetooth();
  const random = await Crypto.getRandomBytesAsync(16);
  const challenge = `0x${Array.from(random, byte => byte.toString(16).padStart(2, '0')).join('')}`;
  const ready = await localLink().connect(peer, invite.request.reqId, challenge);
  try { await verifyConnection(invite, challenge, ready); }
  catch (error) { await localLink().disconnect(); throw error; }
  await offlineFlowStorage.set('radio-outgoing', { invite, peer });
  await offlineFlowStorage.set(`peer:${invite.request.payee.toLowerCase()}`, peer);
}
export async function rememberedPeer(invite: LocalInvite): Promise<string | null> {
  const value = await offlineFlowStorage.get(`peer:${invite.request.payee.toLowerCase()}`);
  return typeof value === 'string' ? value : null;
}
export async function pendingDelivery() {
  const payment = await offlineFlows.getOutgoingPayment();
  const raw = await offlineFlowStorage.get('radio-outgoing');
  if (!payment || !raw) return null;
  const delivery = deliverySchema.parse(raw);
  if (delivery.invite.request.reqId !== payment.request.reqId) throw new Error('Stored delivery does not match the spent payment.');
  return { ...delivery, frames: payment.frames };
}
export async function deliverPayment(invite: LocalInvite, frames: string[], reconnect = false): Promise<void> {
  const saved = deliverySchema.parse(await offlineFlowStorage.get('radio-outgoing'));
  if (saved.invite.request.reqId !== invite.request.reqId) throw new Error('Payment delivery session mismatch.');
  if (reconnect) await prepareDelivery(invite, saved.peer);
  const raw = await localLink().sendProof(JSON.stringify(frameListSchema.parse(frames)));
  await verifyReceipt(invite, frames, raw);
  await offlineFlows.acknowledgeOutgoing(invite.request.reqId);
  await offlineFlowStorage.set('radio-outgoing', null);
}
