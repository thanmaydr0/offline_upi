import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { encodePayload, type VerifyResult } from '@offline-pay/shared';
import { privateKeyToAccount } from 'viem/accounts';
import { offlineFlows, offlineFlowStorage } from '../offline';
import { localLink } from './native';
import { deliverPayment, pendingDelivery, prepareDelivery, receiveRadioProof, receiverInvite } from './index';
import { signConnection, signReceipt } from './protocol';

jest.mock('expo-crypto', () => ({ getRandomBytesAsync: async (count: number) => new Uint8Array(count).fill(17) }));
jest.mock('../offline', () => {
  const values = new Map<string, unknown>();
  return {
    offlineFlowStorage: { get: async (key: string) => values.get(key) ?? null,
      set: async (key: string, value: unknown) => { values.set(key, value); } },
    offlineFlows: { receiveFrame: jest.fn(), resetFrames: jest.fn(), getOutgoingPayment: jest.fn(),
      acknowledgeOutgoing: jest.fn(), payRequest: jest.fn() },
  };
});
jest.mock('./native', () => {
  const link = { respond: jest.fn(), pairedDevices: jest.fn(), connect: jest.fn(), sendProof: jest.fn(), disconnect: jest.fn() };
  return { localLink: () => link, ensureBluetooth: async () => undefined };
});
const flow = jest.mocked(offlineFlows);
const radio = jest.mocked(localLink());
const request = { v: 1 as const, reqId: `0x${'77'.repeat(16)}` as const,
  payee: privateKeyToAccount(`0x${'22'.repeat(32)}`).address, inrPaise: 100, chainId: 84532, ts: 1900000000 };
const frames = [encodePayload({ reqId: request.reqId })];
beforeEach(async () => {
  jest.clearAllMocks();
  await offlineFlowStorage.set('radio-outgoing', null);
  flow.receiveFrame.mockResolvedValue({ ok: true, risk: 'low', totalInrPaise: 100n });
});
describe('local delivery coordinator', () => {
  test('acknowledges only after the receiver verifier and durable save have resolved', async () => {
    await receiverInvite(request);
    let persist!: (value: VerifyResult) => void;
    flow.receiveFrame.mockImplementationOnce(() => new Promise(resolve => { persist = resolve; }));
    const receipt = receiveRadioProof({ id: 'connection1', session: request.reqId, payload: JSON.stringify(frames) });
    while (!persist) await new Promise(resolve => setTimeout(resolve, 0));
    expect(radio.respond).not.toHaveBeenCalled();
    persist({ ok: true, risk: 'low', totalInrPaise: 100n });
    await receipt;
    expect(radio.respond).toHaveBeenCalledTimes(1);
  });
  test('does not send a success acknowledgement when verification or persistence fails', async () => {
    await receiverInvite(request);
    flow.receiveFrame.mockResolvedValue({ ok: false, risk: 'high', reason: 'disk full' });
    await expect(receiveRadioProof({ id: 'connection2', session: request.reqId, payload: JSON.stringify(frames) })).rejects.toThrow('disk full');
    expect(radio.respond).not.toHaveBeenCalled();
  });
  test('reconnects and reuses the saved proof without signing or spending a second time', async () => {
    const invite = await receiverInvite(request);
    radio.connect.mockImplementation(async (_peer, _reqId, challenge) => signConnection(invite, challenge, `0x${'11'.repeat(32)}`));
    await prepareDelivery(invite, 'AA:BB:CC:DD:EE:FF');
    flow.getOutgoingPayment.mockResolvedValue({ request, frames, voucherIds: [], ready: true });
    expect(await pendingDelivery()).toMatchObject({ invite, frames, peer: 'AA:BB:CC:DD:EE:FF' });
    radio.sendProof.mockResolvedValue(await signReceipt(invite, frames, `0x${'11'.repeat(32)}`));
    await deliverPayment(invite, frames, true);
    expect(flow.acknowledgeOutgoing).toHaveBeenCalledWith(request.reqId);
    expect(flow.payRequest).not.toHaveBeenCalled();
  });
  test('retains pending payment when the peer sends a forged acknowledgement', async () => {
    const invite = await receiverInvite(request);
    radio.connect.mockImplementation(async (_peer, _reqId, challenge) => signConnection(invite, challenge, `0x${'11'.repeat(32)}`));
    await prepareDelivery(invite, 'AA:BB:CC:DD:EE:FF');
    radio.sendProof.mockResolvedValue(JSON.stringify({ received: true }));
    await expect(deliverPayment(invite, frames)).rejects.toThrow();
    expect(flow.acknowledgeOutgoing).not.toHaveBeenCalled();
    expect(await offlineFlowStorage.get('radio-outgoing')).not.toBeNull();
  });
  test('refuses a paired phone that cannot prove possession of the scanned receiver key before spending', async () => {
    const invite = await receiverInvite(request);
    radio.connect.mockImplementation(async (_peer, _reqId, challenge) => signConnection(invite, challenge, `0x${'22'.repeat(32)}`));
    await expect(prepareDelivery(invite, 'AA:BB:CC:DD:EE:FF')).rejects.toThrow('not the receiver');
    expect(flow.payRequest).not.toHaveBeenCalled();
    expect(radio.disconnect).toHaveBeenCalled();
  });
});
