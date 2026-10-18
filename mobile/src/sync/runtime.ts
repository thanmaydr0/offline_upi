import { useEffect, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import * as Network from 'expo-network';
import * as WebBrowser from 'expo-web-browser';
import * as Crypto from 'expo-crypto';
import { z } from 'zod';
import { services, servicesMode } from '../services';
import { ledgerService } from '../core';
import { withCoreDatabase } from '../core/database';
import { localStore } from '../api/storage';
import { LoadBalanceFlow } from '../api/loadBalance';
import { SyncEngine } from './engine';
import { idSchema, integerSchema } from '../api/schemas';
import { initialTransactions } from '../services/mock/data';

export const syncEngine = new SyncEngine({ ...services, store: localStore,
  api: servicesMode === 'mock' ? { ...services.api,
    history: async () => initialTransactions.map(row => ({ id: row.id, type: row.title, amountInrPaise: row.amountPaise, status: row.status, createdAt: Math.floor(Date.now() / 1000) })),
    payouts: async () => [],
  } : services.api,
  reconcile: servicesMode === 'real' ? async head => {
    // Healthy appends can race a network round-trip. Do not reconcile an old witnessed
    // head over a healthy newer local head (core would correctly reject the mismatch).
    if ((await ledgerService.verifyChain()).ok) return true;
    return ledgerService.reconcileAfterServerWitness(head);
  } : undefined });
export const loadBalanceFlow = new LoadBalanceFlow({ ...services, store: localStore,
  newAttemptId: () => Crypto.randomUUID(),
  acceptMockPaid: servicesMode === 'mock',
  async openPayment(url) {
    if (servicesMode === 'mock') return 'opened';
    const result = await WebBrowser.openBrowserAsync(url);
    return result.type === 'cancel' || result.type === 'dismiss' ? 'cancel' : 'opened';
  },
});
let started = false;
let enabled = false;
export function startSync() {
  if (started) return;
  started = true;
  const run = () => { if (enabled && AppState.currentState === 'active') void syncEngine.run(); };
  AppState.addEventListener('change', state => { if (state === 'active') run(); });
  let connected = false;
  Network.addNetworkStateListener(state => {
    // A LAN backend remains usable even when Android's internet probe fails.
    const next = state.isConnected === true;
    if (next && !connected) run();
    connected = next;
  });
  void syncEngine.hydrate().catch(() => undefined);
  void loadBalanceFlow.hydrate().catch(() => undefined);
  void Network.getNetworkStateAsync().then(state => { connected = state.isConnected === true; if (connected) run(); }).catch(() => undefined);
}
export function enableSync() { enabled = true; startSync(); void syncEngine.run(); }
export function disableSync() { enabled = false; }
export function useSync() {
  useEffect(() => { startSync(); }, []);
  return useSyncExternalStore(syncEngine.subscribe, syncEngine.getState, syncEngine.getState);
}
export function useLoadBalance() {
  return useSyncExternalStore(loadBalanceFlow.subscribe, loadBalanceFlow.getState, loadBalanceFlow.getState);
}
const receivedStatusSchema = z.object({ voucherId: idSchema, status: z.string(), settlementStatus: integerSchema.nullable(),
  inrPaise: integerSchema, receivedAt: integerSchema });
export type ReceivedStatus = z.infer<typeof receivedStatusSchema>;
export async function receivedStatuses(): Promise<ReceivedStatus[]> {
  if (servicesMode === 'mock') return (await services.received.pending()).map(item => ({ voucherId: item.voucher.voucherId,
    status: 'pending', settlementStatus: null, inrPaise: item.voucher.inrPaise, receivedAt: Date.now() }));
  return withCoreDatabase(async db => {
    const rows = await db.getAllAsync<{ voucher_id: string; status: string; settlement_status: number | null; proof_item_json: string; received_at_ms: number }>(
      'SELECT voucher_id, status, settlement_status, proof_item_json, received_at_ms FROM received ORDER BY received_at_ms DESC');
    return rows.map(row => {
      const item = z.object({ voucher: z.object({ inrPaise: integerSchema }) }).parse(JSON.parse(row.proof_item_json) as unknown);
      return receivedStatusSchema.parse({ voucherId: row.voucher_id, status: row.status, settlementStatus: row.settlement_status,
        inrPaise: item.voucher.inrPaise, receivedAt: row.received_at_ms });
    });
  });
}
