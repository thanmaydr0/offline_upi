import * as SecureStore from 'expo-secure-store';
import { z } from 'zod';
import { withCoreDatabase } from '../core/database';
import { encodeJson, urlSchema } from './schemas';

export interface LocalStore {
  read<S extends z.ZodTypeAny>(key: string, schema: S): Promise<z.output<S> | null>;
  write(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}
// Larger journals/configs live in P4's encrypted database, never SecureStore values.
export const localStore: LocalStore = {
  async read(key, schema) {
    return withCoreDatabase(async db => {
      const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM core_meta WHERE key = ?', `p6.${key}`);
      return row ? schema.parse(JSON.parse(row.value) as unknown) : null;
    });
  },
  async write(key, value) {
    await withCoreDatabase(async db => { await db.runAsync('INSERT INTO core_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', `p6.${key}`, encodeJson(value)); });
  },
  async remove(key) {
    await withCoreDatabase(async db => { await db.runAsync('DELETE FROM core_meta WHERE key = ?', `p6.${key}`); });
  },
};
export interface SessionStorage {
  getToken(origin: string): Promise<string | null>;
  setToken(origin: string, token: string): Promise<void>;
  getOverride(): Promise<string | null>;
}
const sessionSchema = z.object({ origin: urlSchema, token: z.string().min(1).max(8192) });
export const sessionStorage: SessionStorage = {
  async getToken(origin) {
    const raw = await SecureStore.getItemAsync('offlinepay.api-session.v1');
    if (!raw) return null;
    const session = sessionSchema.parse(JSON.parse(raw) as unknown);
    return session.origin === origin ? session.token : null;
  },
  async setToken(origin, token) {
    await SecureStore.setItemAsync('offlinepay.api-session.v1', JSON.stringify(sessionSchema.parse({ origin, token })));
  },
  getOverride: () => SecureStore.getItemAsync('offlinepay.api-url.v1'),
};
export async function setApiUrl(value: string): Promise<void> {
  if (!value.trim()) await SecureStore.deleteItemAsync('offlinepay.api-url.v1');
  else await SecureStore.setItemAsync('offlinepay.api-url.v1', urlSchema.parse(value.trim()).replace(/\/+$/, ''));
}
