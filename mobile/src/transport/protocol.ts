import { decodePayload, encodePayload, reassembleFrames, type Hex } from '@offline-pay/shared';
import { isAddress, keccak256, stringToHex, verifyMessage } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';
import { requestSchema, MAX_FRAME_CHARS, MAX_FRAMES } from '../offline/flows';

const address = z.string().refine(isAddress).transform(value => value as `0x${string}`);
export const inviteSchema = z.object({ v: z.literal(1), request: requestSchema, receiptAddress: address }).strict();
export type LocalInvite = z.infer<typeof inviteSchema>;
export const frameListSchema = z.array(z.string().min(7).max(MAX_FRAME_CHARS)).min(1).max(MAX_FRAMES);
const ackSchema = z.object({ v: z.literal(1), reqId: z.string(), proofHash: z.string(),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/).transform(value => value as Hex) }).strict();
const connectionSchema = z.object({ reqId: z.string(), challenge: z.string().regex(/^0x[0-9a-f]{32}$/),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/).transform(value => value as Hex) }).strict();
function connectionMessage(invite: LocalInvite, challenge: string): string {
  return `OfflinePay connect v1\n${invite.request.reqId}\n${challenge}`;
}
export async function signConnection(invite: LocalInvite, challenge: string, key: Hex): Promise<string> {
  z.string().regex(/^0x[0-9a-f]{32}$/).parse(challenge);
  const signature = await privateKeyToAccount(key).signMessage({ message: connectionMessage(invite, challenge) });
  return JSON.stringify({ reqId: invite.request.reqId, challenge, signature });
}
export async function verifyConnection(invite: LocalInvite, challenge: string, raw: string): Promise<void> {
  const ready = connectionSchema.parse(JSON.parse(raw) as unknown);
  if (ready.reqId !== invite.request.reqId || ready.challenge !== challenge || !await verifyMessage({
    address: invite.receiptAddress, message: connectionMessage(invite, challenge), signature: ready.signature,
  })) throw new Error('The connected phone is not the receiver whose QR you scanned. No vouchers were spent.');
}
export function inviteQr(invite: LocalInvite): string {
  return encodePayload(inviteSchema.parse(invite)).replace(/^OPAY1:/, 'OPAYBT1:');
}
export function parseInvite(qr: string): LocalInvite {
  if (!qr.startsWith('OPAYBT1:') || qr.length > 2000) throw new Error('Scan a new Bluetooth payment QR from the receiver’s Receive screen.');
  return inviteSchema.parse(decodePayload<unknown>(qr.replace(/^OPAYBT1:/, 'OPAY1:')));
}
export function proofHash(frames: string[]): Hex {
  frameListSchema.parse(frames);
  return keccak256(stringToHex(frames.length === 1 ? frames[0] : reassembleFrames(frames)));
}
function receiptMessage(invite: LocalInvite, hash: string): string {
  const request = invite.request;
  return `OfflinePay local receipt v1\n${request.chainId}\n${request.reqId}\n${request.payee.toLowerCase()}\n${request.inrPaise}\n${hash}`;
}
export async function signReceipt(invite: LocalInvite, frames: string[], key: Hex): Promise<string> {
  const hash = proofHash(frames);
  const account = privateKeyToAccount(key);
  if (account.address.toLowerCase() !== invite.receiptAddress.toLowerCase()) throw new Error('Wrong receiver session key.');
  const signature = await account.signMessage({ message: receiptMessage(invite, hash) });
  return JSON.stringify({ v: 1, reqId: invite.request.reqId, proofHash: hash, signature });
}
export async function verifyReceipt(invite: LocalInvite, frames: string[], raw: string): Promise<void> {
  if (raw.length > 2000) throw new Error('Invalid receiver acknowledgement.');
  const ack = ackSchema.parse(JSON.parse(raw) as unknown);
  const hash = proofHash(frames);
  if (ack.reqId !== invite.request.reqId || ack.proofHash !== hash || !await verifyMessage({
    address: invite.receiptAddress, message: receiptMessage(invite, hash), signature: ack.signature,
  })) throw new Error('The receiver has not confirmed this payment. Retry delivery; do not pay again.');
}
