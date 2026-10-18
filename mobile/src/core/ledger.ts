import * as SecureStore from "expo-secure-store";
import type { Hex, LedgerEntry } from "@offline-pay/shared";
import { concatHex, keccak256, stringToHex, toHex } from "viem";
import { z } from "zod";
import { withCoreDatabase } from "./database";
import { parseJson } from "./schema";
import type { LedgerService as LedgerServiceInterface } from "../services/types";

const SECURE_ANCHOR_KEY = "offlinepay.ledger-anchor.v1";
const TAMPER_FLAG_KEY = "offlinepay.ledger-tampered.v1";
const GENESIS_HASH = `0x${"00".repeat(32)}` as Hex;
const UINT64_MAX = (1n << 64n) - 1n;

const rowSchema = z.object({
  counter: z.string().regex(/^\d+$/),
  kind: z.string().min(1),
  entry_json: z.string(),
  previous_hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
});
const anchorSchema = z.object({
  hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((value) => value as Hex),
  counter: z.union([z.bigint(), z.string().regex(/^\d+$/).transform((value) => BigInt(value))]),
});
const inputSchema = z.record(z.string(), z.unknown()).refine(
  (entry) => typeof entry.kind === "string" && entry.kind.length > 0,
  "Ledger entries require a non-empty kind.",
);

type LedgerRow = z.infer<typeof rowSchema>;
type Anchor = { hash: Hex; counter: bigint };
let tamperSeenInMemory = false;

export class LedgerTamperedError extends Error {
  readonly code = "LEDGER_TAMPERED";

  constructor() {
    super("The offline ledger does not match its protected anchor. Offline spending is disabled until online reconciliation.");
    this.name = "LedgerTamperedError";
  }
}

function canonicalValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Ledger values must contain only finite numbers.");
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => {
      const item = record[key];
      if (item === undefined) throw new Error("Ledger values cannot contain undefined fields.");
      return `${JSON.stringify(key)}:${canonicalValue(item)}`;
    }).join(",")}}`;
  }
  throw new Error("Ledger values must be JSON-compatible.");
}

export function canonicalJson(value: unknown): string {
  return canonicalValue(value);
}

function hashLedgerEntry(previousHash: Hex, entryJson: string, counter: bigint): Hex {
  if (counter < 0n || counter > UINT64_MAX) throw new Error("Ledger counter exceeds the uint64 range.");
  // Counter is uint64 big-endian, making the final field fixed-width and unambiguous.
  return keccak256(concatHex([previousHash, stringToHex(entryJson), toHex(counter, { size: 8 })]));
}

function decodeAnchor(encoded: string | null): Anchor | null {
  if (encoded === null) return null;
  const parsed: unknown = JSON.parse(encoded);
  const anchor = anchorSchema.parse(parsed);
  return { hash: anchor.hash, counter: anchor.counter };
}

function sameAnchor(left: Anchor | null, right: Anchor | null): boolean {
  return left !== null && right !== null && left.hash.toLowerCase() === right.hash.toLowerCase() && left.counter === right.counter;
}

async function getDbAnchor(database: Parameters<Parameters<typeof withCoreDatabase>[0]>[0]): Promise<Anchor | null> {
  const row = await database.getFirstAsync<{ value: string }>("SELECT value FROM ledger_meta WHERE key = ?", "anchor");
  return decodeAnchor(row?.value ?? null);
}

async function setDbAnchor(database: Parameters<Parameters<typeof withCoreDatabase>[0]>[0], anchor: Anchor): Promise<void> {
  await database.runAsync(
    "INSERT INTO ledger_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    "anchor",
    JSON.stringify({ hash: anchor.hash, counter: anchor.counter.toString() }),
  );
}

async function getRows(database: Parameters<Parameters<typeof withCoreDatabase>[0]>[0]): Promise<LedgerRow[]> {
  const rows = await database.getAllAsync<unknown>("SELECT counter, kind, entry_json, previous_hash, hash FROM ledger ORDER BY CAST(counter AS INTEGER) ASC");
  return rows.map((row) => rowSchema.parse(row));
}

function verifyRows(rows: LedgerRow[]): { ok: true; anchor: Anchor } | { ok: false; brokenAt: bigint; computed: Anchor } {
  let previousHash = GENESIS_HASH;
  let expectedCounter = 1n;
  for (const row of rows) {
    const counter = BigInt(row.counter);
    if (counter !== expectedCounter || row.previous_hash.toLowerCase() !== previousHash.toLowerCase()) {
      return { ok: false, brokenAt: expectedCounter, computed: { hash: previousHash, counter: expectedCounter - 1n } };
    }
    let entry: unknown;
    try {
      entry = parseJson<unknown>(row.entry_json);
      const parsed = inputSchema.parse(entry);
      if (canonicalJson(parsed) !== row.entry_json || parsed.kind !== row.kind) {
        return { ok: false, brokenAt: counter, computed: { hash: previousHash, counter: counter - 1n } };
      }
    } catch {
      return { ok: false, brokenAt: counter, computed: { hash: previousHash, counter: counter - 1n } };
    }
    const expectedHash = hashLedgerEntry(previousHash, row.entry_json, counter);
    if (expectedHash.toLowerCase() !== row.hash.toLowerCase()) {
      return { ok: false, brokenAt: counter, computed: { hash: previousHash, counter: counter - 1n } };
    }
    previousHash = row.hash as Hex;
    expectedCounter += 1n;
  }
  return { ok: true, anchor: { hash: previousHash, counter: expectedCounter - 1n } };
}

async function secureAnchor(): Promise<Anchor | null> {
  return decodeAnchor(await SecureStore.getItemAsync(SECURE_ANCHOR_KEY));
}

async function setSecureAnchor(anchor: Anchor): Promise<void> {
  await SecureStore.setItemAsync(
    SECURE_ANCHOR_KEY,
    JSON.stringify({ hash: anchor.hash, counter: anchor.counter.toString() }),
    { requireAuthentication: false },
  );
}

async function hasTamperFlag(): Promise<boolean> {
  return tamperSeenInMemory || (await SecureStore.getItemAsync(TAMPER_FLAG_KEY)) === "1";
}

async function markTampered(): Promise<void> {
  tamperSeenInMemory = true;
  try {
    await SecureStore.setItemAsync(TAMPER_FLAG_KEY, "1", { requireAuthentication: false });
  } catch {
    // The in-memory flag still blocks spending for this process if SecureStore is unavailable.
  }
}

async function readAndVerify(database: Parameters<Parameters<typeof withCoreDatabase>[0]>[0], allowTamperFlag = false): Promise<{
  result: { ok: true; anchor: Anchor } | { ok: false; brokenAt: bigint; computed: Anchor };
  dbAnchor: Anchor | null;
  secure: Anchor | null;
  rows: LedgerRow[];
  flagged: boolean;
}> {
  const rows = await getRows(database);
  const result = verifyRows(rows);
  const dbAnchor = await getDbAnchor(database);
  const secure = await secureAnchor();
  const flagged = await hasTamperFlag();

  if (rows.length === 0 && dbAnchor === null && secure === null) {
    await setDbAnchor(database, { hash: GENESIS_HASH, counter: 0n });
    await setSecureAnchor({ hash: GENESIS_HASH, counter: 0n });
    return { result: { ok: true, anchor: { hash: GENESIS_HASH, counter: 0n } }, dbAnchor: { hash: GENESIS_HASH, counter: 0n }, secure: { hash: GENESIS_HASH, counter: 0n }, rows, flagged };
  }

  if (!allowTamperFlag && flagged) {
    return { result: { ok: false, brokenAt: 0n, computed: result.ok ? result.anchor : result.computed }, dbAnchor, secure, rows, flagged };
  }
  if (!result.ok) return { result, dbAnchor, secure, rows, flagged };
  if (!sameAnchor(dbAnchor, result.anchor) || !sameAnchor(secure, result.anchor)) {
    return { result: { ok: false, brokenAt: result.anchor.counter + 1n, computed: result.anchor }, dbAnchor, secure, rows, flagged };
  }
  return { result, dbAnchor, secure, rows, flagged };
}

function toLedgerEntry(row: LedgerRow): LedgerEntry {
  const payload = parseJson<Record<string, unknown>>(row.entry_json);
  return {
    ...payload,
    hash: row.hash as Hex,
    previousHash: row.previous_hash as Hex,
    counter: BigInt(row.counter),
    kind: row.kind,
  } as LedgerEntry;
}

export class HashChainLedger implements LedgerServiceInterface {
  async append(entry: Omit<LedgerEntry, "hash" | "previousHash" | "counter">): Promise<LedgerEntry> {
    const payload = inputSchema.parse(entry);
    return withCoreDatabase(async (database) => {
      let check: Awaited<ReturnType<typeof readAndVerify>>;
      try {
        check = await readAndVerify(database);
      } catch {
        await markTampered();
        throw new LedgerTamperedError();
      }
      if (!check.result.ok) {
        await markTampered();
        throw new LedgerTamperedError();
      }
      const previousHash = check.result.anchor.hash;
      const counter = check.result.anchor.counter + 1n;
      const entryJson = canonicalJson(payload);
      const kind = z.string().min(1).parse(payload.kind);
      const hash = hashLedgerEntry(previousHash, entryJson, counter);
      const anchor = { hash, counter };

      await database.withTransactionAsync(async () => {
        await database.runAsync(
          "INSERT INTO ledger(counter, kind, entry_json, previous_hash, hash) VALUES(?, ?, ?, ?, ?)",
          counter.toString(),
          kind,
          entryJson,
          previousHash,
          hash,
        );
        await setDbAnchor(database, anchor);
      });
      // SQLite and SecureStore cannot commit atomically; any interruption between these writes
      // creates an anchor mismatch that fails closed and needs a server witness to reconcile.
      await setSecureAnchor(anchor);
      return {
        ...payload,
        hash,
        previousHash,
        counter,
        kind,
      } as LedgerEntry;
    });
  }

  async verifyChain(): Promise<{ ok: boolean; brokenAt?: bigint }> {
    return withCoreDatabase(async (database) => {
      try {
        const check = await readAndVerify(database);
        if (!check.result.ok) {
          await markTampered();
          return { ok: false, brokenAt: check.result.brokenAt };
        }
        return { ok: true };
      } catch {
        await markTampered();
        return { ok: false, brokenAt: 0n };
      }
    });
  }

  async head(): Promise<{ hash: Hex; counter: bigint }> {
    return withCoreDatabase(async (database) => {
      // The head is also sent for online witnessing, so return the recomputed local head even when
      // the protected anchors disagree. A corrupt row still has no trustworthy head and is rejected.
      try {
        const rows = await getRows(database);
        const result = verifyRows(rows);
        if (!result.ok) {
          await markTampered();
          throw new LedgerTamperedError();
        }
        return result.anchor;
      } catch {
        await markTampered();
        throw new LedgerTamperedError();
      }
    });
  }

  async list(): Promise<LedgerEntry[]> {
    return withCoreDatabase(async (database) => (await getRows(database)).map(toLedgerEntry));
  }

  /**
   * Repair an interrupted or mismatched local anchor only after the server confirms this exact
   * locally verified head. A row edit/delete cannot be reconciled unless the server witnessed it.
   */
  async reconcileAfterServerWitness(witnessed: { hash: Hex; counter: bigint }): Promise<boolean> {
    const parsed = anchorSchema.parse({ hash: witnessed.hash, counter: witnessed.counter });
    const witnessedAnchor = { hash: parsed.hash, counter: parsed.counter };
    return withCoreDatabase(async (database) => {
      let result: ReturnType<typeof verifyRows>;
      try {
        result = verifyRows(await getRows(database));
      } catch {
        await markTampered();
        return false;
      }
      if (!result.ok || !sameAnchor(result.anchor, witnessedAnchor)) {
        await markTampered();
        return false;
      }
      await setDbAnchor(database, result.anchor);
      await setSecureAnchor(result.anchor);
      await SecureStore.deleteItemAsync(TAMPER_FLAG_KEY);
      tamperSeenInMemory = false;
      return true;
    });
  }
}

export const ledgerService = new HashChainLedger();

export async function assertLedgerHealthy(): Promise<void> {
  const result = await ledgerService.verifyChain();
  if (!result.ok) throw new LedgerTamperedError();
}

/** Test-only read helper; callers cannot mutate the backing store through this function. */
export async function inspectLedgerRowsForTests(): Promise<unknown[]> {
  return withCoreDatabase((database) => database.getAllAsync<unknown>("SELECT counter, kind, entry_json, previous_hash, hash FROM ledger ORDER BY CAST(counter AS INTEGER) ASC"));
}

/** Test helper to isolate independently initialized app processes. */
export function resetLedgerTamperStateForTests(): void {
  tamperSeenInMemory = false;
}
