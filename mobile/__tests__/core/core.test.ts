import type { Address, Hex, StoredVoucher } from "@offline-pay/shared";
import { DeviceKeyService, KeyInvalidatedError } from "../../src/core/keys";
import { cacheServerConfig, isClockSuspicious } from "../../src/core/clock";
import { resetCoreDatabaseConnectionForTests } from "../../src/core/database";
import { ExactChangeError, OfflineSpendLimitError, SqliteVoucherWallet } from "../../src/core/wallet";
import { HashChainLedger, ledgerService, resetLedgerTamperStateForTests } from "../../src/core/ledger";
import { setDevelopmentIntegrityOverride } from "../../src/core/integrity";

type MockFunction<Args extends unknown[], Result> = ((...args: Args) => Result) & {
  mock: { calls: Args[] };
  mockClear(): void;
  mockImplementation(implementation: (...args: Args) => Result): void;
  mockResolvedValue(value: Awaited<Result>): void;
};
type JestApi = {
  fn<Args extends unknown[], Result>(implementation: (...args: Args) => Result): MockFunction<Args, Result>;
  mock(moduleName: string, factory: () => unknown): void;
  useFakeTimers(): void;
  setSystemTime(time: number | Date): void;
  useRealTimers(): void;
};
type Matchers<T> = {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toMatchObject(expected: object): void;
  toBeInstanceOf(expected: object): void;
  toHaveLength(expected: number): void;
  resolves: Matchers<Awaited<T>>;
  rejects: Matchers<never>;
};
declare const jest: JestApi;
declare function describe(name: string, body: () => void): void;
declare function beforeEach(body: () => void | Promise<void>): void;
declare function afterEach(body: () => void | Promise<void>): void;
declare function test(name: string, body: () => void | Promise<void>): void;
declare function expect<T>(actual: T): Matchers<T>;

type MockVoucherRow = { voucher_id: string; voucher_json: string; inr_paise: number; expiry_seconds: string };
type MockSpentRow = { voucher_id: string; voucher_json: string; req_id: string; spent_at_ms: number; inr_paise: number };
type MockLedgerRow = { counter: string; kind: string; entry_json: string; previous_hash: string; hash: string };
type MockReceivedRow = { voucher_id: string; proof_item_json: string; status: string; settlement_status: number | null; received_at_ms: number };
type MockTables = {
  vouchers: Map<string, MockVoucherRow>;
  spent: Map<string, MockSpentRow>;
  ledger: Map<string, MockLedgerRow>;
  ledgerMeta: Map<string, string>;
  coreMeta: Map<string, string>;
  received: Map<string, MockReceivedRow>;
};

const mockTables: MockTables = {
  vouchers: new Map(),
  spent: new Map(),
  ledger: new Map(),
  ledgerMeta: new Map(),
  coreMeta: new Map(),
  received: new Map(),
};
const mockSecureItems = new Map<string, string>();
let mockUptime = 1_000_000;
const mockDevice = {
  isDevice: true,
  isRootedExperimentalAsync: jest.fn(async () => false),
  getUptimeAsync: jest.fn(async () => mockUptime),
};

function clearMockTables(): void {
  mockTables.vouchers.clear();
  mockTables.spent.clear();
  mockTables.ledger.clear();
  mockTables.ledgerMeta.clear();
  mockTables.coreMeta.clear();
  mockTables.received.clear();
}

function cloneMockTables(): MockTables {
  return {
    vouchers: new Map(mockTables.vouchers),
    spent: new Map(mockTables.spent),
    ledger: new Map(mockTables.ledger),
    ledgerMeta: new Map(mockTables.ledgerMeta),
    coreMeta: new Map(mockTables.coreMeta),
    received: new Map(mockTables.received),
  };
}

function restoreMockTables(snapshot: MockTables): void {
  mockTables.vouchers = snapshot.vouchers;
  mockTables.spent = snapshot.spent;
  mockTables.ledger = snapshot.ledger;
  mockTables.ledgerMeta = snapshot.ledgerMeta;
  mockTables.coreMeta = snapshot.coreMeta;
  mockTables.received = snapshot.received;
}

function asString(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected a string bind value");
  return value;
}

function asNumber(value: unknown): number {
  if (typeof value !== "number") throw new Error("Expected a number bind value");
  return value;
}

class MockDatabase {
  async execAsync(_source: string): Promise<void> {}
  async closeAsync(): Promise<void> {}

  async withTransactionAsync(operation: () => Promise<void>): Promise<void> {
    const snapshot = cloneMockTables();
    try {
      await operation();
    } catch (error) {
      restoreMockTables(snapshot);
      throw error;
    }
  }

  async getFirstAsync<T>(source: string, ...params: unknown[]): Promise<T | null> {
    const sql = source.replace(/\s+/g, " ").trim().toLowerCase();
    let row: unknown = null;
    if (sql === "pragma cipher_version;") row = { cipher_version: "4.6.1" };
    else if (sql.includes("from ledger_meta where key = ?")) {
      const value = mockTables.ledgerMeta.get(asString(params[0]));
      row = value === undefined ? null : { value };
    } else if (sql.includes("from core_meta where key = ?")) {
      const value = mockTables.coreMeta.get(asString(params[0]));
      row = value === undefined ? null : { value };
    } else if (sql.includes("from spent_vouchers where spent_at_ms > ?")) {
      const cutoff = asNumber(params[0]);
      row = { total: Array.from(mockTables.spent.values()).filter((item) => item.spent_at_ms > cutoff).reduce((sum, item) => sum + item.inr_paise, 0) };
    } else if (sql.includes("from vouchers where cast(expiry_seconds as integer) > ?")) {
      const now = asNumber(params[0]);
      row = { total: Array.from(mockTables.vouchers.values()).filter((item) => Number(item.expiry_seconds) > now).reduce((sum, item) => sum + item.inr_paise, 0) };
    } else if (sql.includes("from vouchers where voucher_id = ? union all select voucher_id from spent_vouchers")) {
      const id = asString(params[0]);
      row = mockTables.vouchers.has(id) || mockTables.spent.has(id) || mockTables.received.has(id) ? { voucher_id: id } : null;
    } else if (sql.includes("from received where voucher_id = ? union all select voucher_id from vouchers")) {
      const id = asString(params[0]);
      row = mockTables.received.has(id) || mockTables.vouchers.has(id) || mockTables.spent.has(id) ? { voucher_id: id } : null;
    } else if (sql.includes("from vouchers where voucher_id = ?")) {
      row = mockTables.vouchers.get(asString(params[0])) ?? null;
    }
    return row as T | null;
  }

  async getAllAsync<T>(source: string, ...params: unknown[]): Promise<T[]> {
    const sql = source.replace(/\s+/g, " ").trim().toLowerCase();
    let rows: unknown[] = [];
    if (sql.includes("from ledger order by cast(counter as integer) asc")) {
      rows = Array.from(mockTables.ledger.values()).sort((left, right) => Number(left.counter) - Number(right.counter));
    } else if (sql.includes("from ledger where kind = ?")) {
      rows = Array.from(mockTables.ledger.values()).filter((item) => item.kind === asString(params[0])).map((item) => ({ entry_json: item.entry_json }));
    } else if (sql.includes("from vouchers where cast(expiry_seconds as integer) > ?")) {
      const now = asNumber(params[0]);
      rows = Array.from(mockTables.vouchers.values())
        .filter((item) => Number(item.expiry_seconds) > now)
        .sort((left, right) => Number(left.expiry_seconds) - Number(right.expiry_seconds) || left.inr_paise - right.inr_paise);
    } else if (sql.includes("from received where status = 'pending'")) {
      rows = Array.from(mockTables.received.values()).filter((item) => item.status === "pending");
    }
    return rows as T[];
  }

  async runAsync(source: string, ...params: unknown[]): Promise<{ changes: number; lastInsertRowId: number }> {
    const sql = source.replace(/\s+/g, " ").trim().toLowerCase();
    let changes = 1;
    if (sql.startsWith("insert into core_meta")) {
      mockTables.coreMeta.set(asString(params[0]), asString(params[1]));
    } else if (sql.startsWith("insert into ledger_meta")) {
      mockTables.ledgerMeta.set(asString(params[0]), asString(params[1]));
    } else if (sql.startsWith("insert into ledger(")) {
      const row: MockLedgerRow = {
        counter: asString(params[0]),
        kind: asString(params[1]),
        entry_json: asString(params[2]),
        previous_hash: asString(params[3]),
        hash: asString(params[4]),
      };
      mockTables.ledger.set(row.counter, row);
    } else if (sql.startsWith("insert into vouchers")) {
      const row: MockVoucherRow = {
        voucher_id: asString(params[0]),
        voucher_json: asString(params[1]),
        inr_paise: asNumber(params[2]),
        expiry_seconds: asString(params[3]),
      };
      mockTables.vouchers.set(row.voucher_id, row);
    } else if (sql.startsWith("insert into spent_vouchers")) {
      const row: MockSpentRow = {
        voucher_id: asString(params[0]),
        voucher_json: asString(params[1]),
        req_id: asString(params[2]),
        spent_at_ms: asNumber(params[3]),
        inr_paise: asNumber(params[4]),
      };
      mockTables.spent.set(row.voucher_id, row);
    } else if (sql.startsWith("delete from vouchers")) {
      changes = Number(mockTables.vouchers.delete(asString(params[0])));
    } else if (sql.startsWith("insert into received")) {
      const row: MockReceivedRow = {
        voucher_id: asString(params[0]),
        proof_item_json: asString(params[1]),
        status: "pending",
        settlement_status: null,
        received_at_ms: asNumber(params[2]),
      };
      mockTables.received.set(row.voucher_id, row);
    } else if (sql.startsWith("update received")) {
      const status = asNumber(params[0]);
      const id = asString(params[1]);
      const row = mockTables.received.get(id);
      if (!row || row.status !== "pending") changes = 0;
      else mockTables.received.set(id, { ...row, status: "settled", settlement_status: status });
    }
    return { changes, lastInsertRowId: 1 };
  }
}

const mockDatabase = new MockDatabase();
const mockSecureStore = {
  getItemAsync: jest.fn(async (key: string) => mockSecureItems.get(key) ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => { mockSecureItems.set(key, value); }),
  deleteItemAsync: jest.fn(async (key: string) => { mockSecureItems.delete(key); }),
};
const mockLocalAuthentication = {
  SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
  isEnrolledAsync: jest.fn(async () => true),
  getEnrolledLevelAsync: jest.fn(async () => 3),
};

jest.mock("expo-sqlite", () => ({ openDatabaseAsync: async () => mockDatabase }));
jest.mock("expo-secure-store", () => ({
  __esModule: true,
  getItemAsync: (key: string) => mockSecureStore.getItemAsync(key),
  setItemAsync: (key: string, value: string) => mockSecureStore.setItemAsync(key, value),
  deleteItemAsync: (key: string) => mockSecureStore.deleteItemAsync(key),
}));
jest.mock("expo-crypto", () => ({ getRandomBytesAsync: async (count: number) => new Uint8Array(count).fill(1) }));
jest.mock("expo-device", () => ({
  get isDevice() { return mockDevice.isDevice; },
  isRootedExperimentalAsync: () => mockDevice.isRootedExperimentalAsync(),
  getUptimeAsync: () => mockDevice.getUptimeAsync(),
}));
jest.mock("expo-local-authentication", () => ({
  SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
  isEnrolledAsync: () => mockLocalAuthentication.isEnrolledAsync(),
  getEnrolledLevelAsync: () => mockLocalAuthentication.getEnrolledLevelAsync(),
}));
jest.mock("@offline-pay/shared", () => ({
  CLOCK_SKEW_SECONDS: 300n,
  PAYMENT_TYPES: {
    Payment: [
      { name: "voucherId", type: "bytes32" },
      { name: "device", type: "address" },
      { name: "payee", type: "address" },
      { name: "usdcAmount", type: "uint256" },
      { name: "deadline", type: "uint64" },
    ],
  },
}));

const MOCK_NOW = 1_800_000_000_000;
const TEST_DEVICE = `0x${"11".repeat(20)}` as Address;
const TEST_PAYEE = `0x${"22".repeat(20)}` as Address;
const TEST_VAULT = `0x${"33".repeat(20)}` as Address;
const TEST_REQ_ID = `0x${"aa".repeat(32)}` as Hex;

function makeVoucher(id: number, denomination: number): StoredVoucher {
  return {
    voucher: {
      voucherId: `0x${id.toString(16).padStart(64, "0")}` as Hex,
      device: TEST_DEVICE,
      usdcAmount: BigInt(denomination),
      inrPaise: denomination,
      expiry: BigInt(Math.floor(MOCK_NOW / 1000) + 3600),
    },
    issuerSig: `0x${"44".repeat(65)}` as Hex,
  };
}

async function prepare(config: { maxSingle?: number; maxDaily?: number } = {}): Promise<void> {
  jest.useFakeTimers();
  jest.setSystemTime(MOCK_NOW);
  mockUptime = 1_000_000;
  mockDevice.isRootedExperimentalAsync.mockResolvedValue(false);
  mockDevice.getUptimeAsync.mockImplementation(async () => mockUptime);
  mockLocalAuthentication.getEnrolledLevelAsync.mockResolvedValue(3);
  mockLocalAuthentication.isEnrolledAsync.mockResolvedValue(true);
  mockSecureItems.clear();
  mockSecureStore.getItemAsync.mockClear();
  mockSecureStore.setItemAsync.mockClear();
  clearMockTables();
  resetLedgerTamperStateForTests();
  // Jest runs as a debuggable bundle; test the explicit development-only override.
  setDevelopmentIntegrityOverride(true);
  await resetCoreDatabaseConnectionForTests();
  await cacheServerConfig({
    serverTime: new Date(MOCK_NOW).toISOString(),
    chainId: 84532,
    vaultAddress: TEST_VAULT,
    limits: {
      MAX_SINGLE_OFFLINE_PAYMENT_PAISE: config.maxSingle ?? 5000,
      MAX_OFFLINE_SPEND_24H_PAISE: config.maxDaily ?? 5000,
    },
  });
}

describe("offline core services", () => {
  beforeEach(async () => prepare());
  afterEach(() => jest.useRealTimers());

  test("selects exact change and reports available denominations when no solution exists", async () => {
    const wallet = new SqliteVoucherWallet();
    const twoHundred = makeVoucher(1, 200);
    const fiveHundred = makeVoucher(2, 500);
    await wallet.addIssued([twoHundred, fiveHundred]);

    await expect(wallet.selectForAmount(300)).rejects.toMatchObject({
      name: "ExactChangeError",
      availableDenominationsPaise: [200, 500],
      availableTotalPaise: 700,
    } satisfies Partial<ExactChangeError>);
    await expect(wallet.selectForAmount(700)).resolves.toEqual([twoHundred, fiveHundred]);
  });

  test("marks vouchers spent before markSpent resolves", async () => {
    const wallet = new SqliteVoucherWallet();
    const voucher = makeVoucher(3, 100);
    await wallet.addIssued([voucher]);

    await wallet.markSpent([voucher.voucher.voucherId], TEST_REQ_ID);

    await expect(wallet.list()).resolves.toEqual([]);
    await expect(wallet.offlineBalancePaise()).resolves.toBe(0n);
    expect(mockTables.spent.has(voucher.voucher.voucherId)).toBe(true);
    expect(await ledgerService.verifyChain()).toEqual({ ok: true });
  });

  test("detects a deleted ledger row", async () => {
    const ledger = new HashChainLedger();
    await ledger.append({ kind: "load" });
    await ledger.append({ kind: "spend" });
    mockTables.ledger.delete("1");

    await expect(ledger.verifyChain()).resolves.toMatchObject({ ok: false, brokenAt: 1n });
  });

  test("detects an edited ledger row", async () => {
    const ledger = new HashChainLedger();
    await ledger.append({ kind: "load" });
    const first = mockTables.ledger.get("1");
    if (!first) throw new Error("Expected a ledger row");
    mockTables.ledger.set("1", { ...first, entry_json: '{"kind":"edited"}' });

    await expect(ledger.verifyChain()).resolves.toMatchObject({ ok: false, brokenAt: 1n });
  });

  test("treats malformed anchors as tampering instead of crashing", async () => {
    const ledger = new HashChainLedger();
    await ledger.append({ kind: "load" });
    mockSecureItems.set("offlinepay.ledger-anchor.v1", "not-json");

    await expect(ledger.verifyChain()).resolves.toMatchObject({ ok: false });
    await expect(ledger.append({ kind: "spend" })).rejects.toMatchObject({ code: "LEDGER_TAMPERED" });
  });

  test("detects a mismatch between the database and SecureStore anchors", async () => {
    const ledger = new HashChainLedger();
    await ledger.append({ kind: "load" });
    mockTables.ledgerMeta.set("anchor", JSON.stringify({ hash: `0x${"00".repeat(32)}`, counter: "0" }));

    await expect(ledger.verifyChain()).resolves.toMatchObject({ ok: false });
    const witnessed = await ledger.head();
    await expect(ledger.reconcileAfterServerWitness(witnessed)).resolves.toBe(true);
    await expect(ledger.verifyChain()).resolves.toEqual({ ok: true });
  });

  test("persists a clock rollback flag", async () => {
    await expect(isClockSuspicious()).resolves.toBe(false);
    jest.setSystemTime(MOCK_NOW - 10 * 60 * 1000);

    await expect(isClockSuspicious()).resolves.toBe(true);
    jest.setSystemTime(MOCK_NOW);
    await expect(isClockSuspicious()).resolves.toBe(true);
  });

  test("flags wall-clock drift against elapsed device uptime", async () => {
    mockUptime += 10 * 60 * 1000;

    await expect(isClockSuspicious()).resolves.toBe(true);
  });

  test("enforces the configured single-payment and rolling 24-hour limits", async () => {
    await prepare({ maxSingle: 200, maxDaily: 150 });
    const wallet = new SqliteVoucherWallet();
    const first = makeVoucher(4, 100);
    await wallet.addIssued([first]);
    await expect(wallet.selectForAmount(300)).rejects.toBeInstanceOf(OfflineSpendLimitError);
    await wallet.markSpent([first.voucher.voucherId], TEST_REQ_ID);

    const second = makeVoucher(5, 100);
    await wallet.addIssued([second]);
    await expect(wallet.selectForAmount(100)).rejects.toMatchObject({ name: "OfflineSpendLimitError" });
  });

  test("does not reset the rolling limit when a spent-voucher row is deleted", async () => {
    await prepare({ maxSingle: 200, maxDaily: 150 });
    const wallet = new SqliteVoucherWallet();
    const first = makeVoucher(11, 100);
    await wallet.addIssued([first]);
    await wallet.markSpent([first.voucher.voucherId], TEST_REQ_ID);
    mockTables.spent.delete(first.voucher.voucherId);
    const second = makeVoucher(12, 100);
    await wallet.addIssued([second]);

    await expect(wallet.selectForAmount(100)).rejects.toMatchObject({ name: "OfflineSpendLimitError" });
  });

  test("blocks offline selection on rooted devices", async () => {
    setDevelopmentIntegrityOverride(false);
    mockDevice.isRootedExperimentalAsync.mockResolvedValue(true);
    const wallet = new SqliteVoucherWallet();
    await wallet.addIssued([makeVoucher(6, 100)]);

    await expect(wallet.selectForAmount(100)).rejects.toMatchObject({ code: "OFFLINE_INTEGRITY_BLOCKED" });
  });

  test("allows a rooted-device override only when explicitly enabled in development", async () => {
    mockDevice.isRootedExperimentalAsync.mockResolvedValue(true);
    const wallet = new SqliteVoucherWallet();
    const voucher = makeVoucher(7, 100);
    await wallet.addIssued([voucher]);
    setDevelopmentIntegrityOverride(true);

    await expect(wallet.selectForAmount(100)).resolves.toEqual([voucher]);
  });

  test("blocks spending in a debuggable build unless the development override is explicit", async () => {
    setDevelopmentIntegrityOverride(false);
    const wallet = new SqliteVoucherWallet();
    await wallet.addIssued([makeVoucher(8, 100)]);

    await expect(wallet.selectForAmount(100)).rejects.toMatchObject({ code: "OFFLINE_INTEGRITY_BLOCKED" });
  });

  test("refuses key initialization when neither biometrics nor a device credential is enrolled", async () => {
    mockLocalAuthentication.getEnrolledLevelAsync.mockResolvedValue(0);
    const keys = new DeviceKeyService();

    await expect(keys.init()).rejects.toMatchObject({ code: "AUTH_NOT_ENROLLED" });
    await expect(keys.getKeyState()).resolves.toBe("NOT_ENROLLED");
  });

  test("does not allow offline wallet selection without an enrolled device credential", async () => {
    mockLocalAuthentication.getEnrolledLevelAsync.mockResolvedValue(0);
    const wallet = new SqliteVoucherWallet();
    await wallet.addIssued([makeVoucher(13, 100)]);

    await expect(wallet.selectForAmount(100)).rejects.toMatchObject({ code: "OFFLINE_INTEGRITY_BLOCKED" });
  });

  test("reports a biometric key invalidation instead of signing with a new identity", async () => {
    const keys = new DeviceKeyService();
    const { address } = await keys.init();
    mockSecureItems.delete("offlinepay.device-private-key.v1");
    const payment = {
      voucherId: `0x${"55".repeat(32)}` as Hex,
      device: address,
      payee: TEST_PAYEE,
      usdcAmount: 100n,
      deadline: BigInt(Math.floor(MOCK_NOW / 1000) + 1200),
    };

    await expect(keys.signPayments([payment], "Pay")).rejects.toBeInstanceOf(KeyInvalidatedError);
    await expect(keys.getKeyState()).resolves.toBe("KEY_INVALIDATED");
    await expect(keys.init()).rejects.toBeInstanceOf(KeyInvalidatedError);
    const protectedKeyReads = mockSecureStore.getItemAsync.mock.calls
      .filter(([key]) => key === "offlinepay.device-private-key.v1");
    expect(protectedKeyReads).toHaveLength(1);
  });

  test("reads the protected key once and signs a whole batch", async () => {
    const keys = new DeviceKeyService();
    const { address } = await keys.init();
    mockSecureStore.getItemAsync.mockClear();
    const payment = (id: number) => ({
      voucherId: `0x${id.toString(16).padStart(64, "0")}` as Hex,
      device: address,
      payee: TEST_PAYEE,
      usdcAmount: 100n,
      deadline: BigInt(Math.floor(MOCK_NOW / 1000) + 1200),
    });

    const signatures = await keys.signPayments([payment(9), payment(10)], "Confirm both payments");
    expect(signatures).toHaveLength(2);
    const protectedKeyReads = mockSecureStore.getItemAsync.mock.calls
      .filter(([key]) => key === "offlinepay.device-private-key.v1");
    expect(protectedKeyReads).toHaveLength(1);
  });
});
