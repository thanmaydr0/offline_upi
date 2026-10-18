import * as SecureStore from 'expo-secure-store';
import { reloadAppAsync } from 'expo';
import { withCoreDatabase } from '../core/database';

/** Destructive reset discards identity too: never reuse a signing key with a reset ledger counter.
 * TODO(P4): expose a core reset API instead of knowing its storage keys here.
 */
export async function resetLocalData(): Promise<void> {
  await withCoreDatabase(async db => {
    await db.withTransactionAsync(async () => {
      await db.execAsync('DELETE FROM vouchers; DELETE FROM spent_vouchers; DELETE FROM received; DELETE FROM ledger; DELETE FROM ledger_meta; DELETE FROM core_meta;');
    });
  });
  for (const key of ['offlinepay.api-session.v1', 'offlinepay.api-url.v1', 'offlinepay.device-private-key.v1',
    'offlinepay.device-key-present.v1', 'offlinepay.device-address.v1', 'offlinepay.clock-state.v1',
    'offlinepay.ledger-anchor.v1', 'offlinepay.ledger-tampered.v1']) await SecureStore.deleteItemAsync(key);
  // Retain the encryption key: the now-empty, open SQLCipher database still uses it.
  await reloadAppAsync('Local data reset');
}
