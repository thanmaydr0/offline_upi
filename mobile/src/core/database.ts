import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import * as SQLite from "expo-sqlite";
import type { SQLiteDatabase } from "expo-sqlite";

const DATABASE_NAME = "offlinepay.db";
const DATABASE_KEY_STORE = "offlinepay.database-key.v1";
const DATABASE_KEY_BYTES = 32;

let databasePromise: Promise<SQLiteDatabase> | undefined;
let queue: Promise<void> = Promise.resolve();

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function loadOrCreateDatabaseKey(): Promise<string> {
  const stored = await SecureStore.getItemAsync(DATABASE_KEY_STORE);
  if (stored !== null) {
    if (!/^[0-9a-f]{64}$/i.test(stored)) throw new Error("The encrypted database key is invalid.");
    return stored;
  }

  const key = await Crypto.getRandomBytesAsync(DATABASE_KEY_BYTES);
  const encoded = bytesToHex(key);
  key.fill(0);
  await SecureStore.setItemAsync(DATABASE_KEY_STORE, encoded, { requireAuthentication: false });
  return encoded;
}

async function openCoreDatabase(): Promise<SQLiteDatabase> {
  if (databasePromise) return databasePromise;

  databasePromise = (async () => {
    const key = await loadOrCreateDatabaseKey();
    const database = await SQLite.openDatabaseAsync(DATABASE_NAME);
    try {
      // SQLCipher is enabled by the existing expo-sqlite app config. This is a raw 256-bit key,
      // held briefly in JS; the key itself is kept in SecureStore without a biometric prompt.
      await database.execAsync(`PRAGMA key = "x'${key}'";`);
      const cipher = await database.getFirstAsync<{ cipher_version?: string }>("PRAGMA cipher_version;");
      if (!cipher?.cipher_version) {
        throw new Error("SQLCipher is unavailable; refusing to open an unencrypted offline database.");
      }
      await database.execAsync(`
        PRAGMA foreign_keys = ON;
        PRAGMA secure_delete = ON;
        CREATE TABLE IF NOT EXISTS vouchers (
          voucher_id TEXT PRIMARY KEY NOT NULL,
          voucher_json TEXT NOT NULL,
          inr_paise INTEGER NOT NULL,
          expiry_seconds TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS spent_vouchers (
          voucher_id TEXT PRIMARY KEY NOT NULL,
          voucher_json TEXT NOT NULL,
          req_id TEXT NOT NULL,
          spent_at_ms INTEGER NOT NULL,
          inr_paise INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ledger (
          counter TEXT PRIMARY KEY NOT NULL,
          kind TEXT NOT NULL,
          entry_json TEXT NOT NULL,
          previous_hash TEXT NOT NULL,
          hash TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ledger_meta (
          key TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS received (
          voucher_id TEXT PRIMARY KEY NOT NULL,
          proof_item_json TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          settlement_status INTEGER,
          received_at_ms INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS core_meta (
          key TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS spent_vouchers_spent_at_idx ON spent_vouchers(spent_at_ms);
        CREATE INDEX IF NOT EXISTS received_status_idx ON received(status);
      `);
      return database;
    } catch (error) {
      await database.closeAsync();
      throw error;
    }
  })();

  try {
    return await databasePromise;
  } catch (error) {
    databasePromise = undefined;
    throw error;
  }
}

/** Serializes all access to the shared connection so SQLite transactions cannot interleave. */
export async function withCoreDatabase<T>(operation: (database: SQLiteDatabase) => Promise<T>): Promise<T> {
  const prior = queue;
  let release = (): void => undefined;
  queue = new Promise<void>((resolve) => { release = resolve; });
  await prior;
  try {
    const database = await openCoreDatabase();
    return await operation(database);
  } finally {
    release();
  }
}

/** Test helper; it only drops the JS connection cache and never deletes user data. */
export async function resetCoreDatabaseConnectionForTests(): Promise<void> {
  const previous = databasePromise;
  databasePromise = undefined;
  if (previous) {
    try {
      await (await previous).closeAsync();
    } catch {
      // The test may already have reset its mocked connection.
    }
  }
}
