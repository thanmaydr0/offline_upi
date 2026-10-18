import * as Crypto from 'expo-crypto';
import { conservativeNowSeconds, isClockSuspicious } from '../core/clock';
import { readCachedServerConfig } from '../core/config';
import { withCoreDatabase } from '../core/database';
import { keyService } from '../core/keys';
import { ledgerService } from '../core/ledger';
import { receivedStore } from '../core/received';
import { voucherWallet } from '../core/wallet';
import { OfflineFlowController, type FlowStorage } from './flows';

const storage: FlowStorage = {
  get: (key) => withCoreDatabase(async (db) => {
    const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM core_meta WHERE key = ?', `p7:${key}`);
    return row ? JSON.parse(row.value) as unknown : null;
  }),
  set: (key, value) => withCoreDatabase(async (db) => {
    await db.runAsync('INSERT INTO core_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      `p7:${key}`, JSON.stringify(value));
  }),
};

/** Real local-only implementation. This module never imports ApiClient or services wiring. */
export const offlineFlows = new OfflineFlowController({
  keys: keyService, wallet: voucherWallet, ledger: ledgerService, received: receivedStore, storage,
  cachedConfig: readCachedServerConfig,
  nowSeconds: async () => Number(await conservativeNowSeconds()),
  randomBytes: Crypto.getRandomBytesAsync,
  assertClockHealthy: async () => {
    if (await isClockSuspicious()) throw new Error('Offline clock is not trusted. Sync verified time before airplane mode.');
  },
  walletAppendsSpendLedger: true,
});

export { OfflineFlowController, formatOfflineInr, exposureRisk, REQUEST_TTL_SECONDS } from './flows';
export type { FlowDependencies, FlowStorage } from './flows';
