import type { Hex, StoredVoucher } from "@offline-pay/shared";
import { z } from "zod";
import { conservativeNowMs, conservativeNowSeconds } from "./clock";
import { getOfflineLimits } from "./config";
import { withCoreDatabase } from "./database";
import { assertOfflineIntegrity } from "./integrity";
import { assertLedgerHealthy, ledgerService } from "./ledger";
import { parseJson, parseStoredVoucher, stringifyJson } from "./schema";
import type { VoucherWallet as VoucherWalletInterface } from "../services/types";

const voucherIdSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((value) => value.toLowerCase() as Hex);
const paiseSchema = z.number().int().positive().safe();
const OFFLINE_DAY_MS = 24 * 60 * 60 * 1000;

type VoucherRow = { voucher_id: string; voucher_json: string; inr_paise: number; expiry_seconds: string };
const spendLedgerEntrySchema = z.object({
  kind: z.literal("offline_spend"),
  inrPaise: z.number().int().nonnegative().safe(),
  spentAtMs: z.number().int().nonnegative().safe(),
});

export class ExactChangeError extends Error {
  constructor(
    readonly requestedPaise: number,
    readonly availableDenominationsPaise: number[],
    readonly availableTotalPaise: number,
  ) {
    const available = availableDenominationsPaise.length > 0 ? availableDenominationsPaise.join(", ") : "none";
    super(`Exact change for ${requestedPaise} paise is unavailable. Available unspent denominations: ${available} paise (total ${availableTotalPaise} paise).`);
    this.name = "ExactChangeError";
  }
}

export class OfflineSpendLimitError extends Error {
  constructor(
    readonly spentPaise: number,
    readonly limitPaise: number,
    readonly requestedPaise: number,
    readonly limitKind: "single-payment" | "rolling-24-hour" = "rolling-24-hour",
  ) {
    super(limitKind === "single-payment"
      ? `Single offline payment limit exceeded: ${requestedPaise} paise requested; limit ${limitPaise} paise.`
      : `Offline 24-hour spend limit exceeded: ${spentPaise} paise already spent; ${requestedPaise} paise requested; limit ${limitPaise} paise.`);
    this.name = "OfflineSpendLimitError";
  }
}

function decodeVoucherRow(row: VoucherRow): StoredVoucher {
  return parseStoredVoucher(JSON.parse(row.voucher_json));
}

function chooseExactChange(vouchers: StoredVoucher[], requestedPaise: number): StoredVoucher[] | null {
  const selections = new Map<number, number[]>([[0, []]]);
  for (let index = 0; index < vouchers.length; index += 1) {
    const denomination = vouchers[index].voucher.inrPaise;
    const current = Array.from(selections.entries()).sort((left, right) => right[0] - left[0]);
    for (const [total, chosen] of current) {
      const nextTotal = total + denomination;
      if (nextTotal > requestedPaise) continue;
      const nextChosen = [...chosen, index];
      const previous = selections.get(nextTotal);
      if (!previous || nextChosen.length < previous.length) selections.set(nextTotal, nextChosen);
    }
  }
  const indices = selections.get(requestedPaise);
  return indices ? indices.map((index) => vouchers[index]) : null;
}

async function getRollingSpendTotal(database: Parameters<Parameters<typeof withCoreDatabase>[0]>[0], nowMs: number): Promise<number> {
  const cutoffMs = nowMs - OFFLINE_DAY_MS;
  const spentRows = await database.getFirstAsync<{ total: number | null }>(
    "SELECT COALESCE(SUM(inr_paise), 0) AS total FROM spent_vouchers WHERE spent_at_ms > ?",
    cutoffMs,
  );
  const ledgerRows = await database.getAllAsync<{ entry_json: string }>(
    "SELECT entry_json FROM ledger WHERE kind = ?",
    "offline_spend",
  );
  const ledgerTotal = ledgerRows.reduce((sum, row) => {
    const entry = spendLedgerEntrySchema.parse(parseJson<unknown>(row.entry_json));
    return entry.spentAtMs > cutoffMs ? sum + entry.inrPaise : sum;
  }, 0);
  // The ledger is anchored independently; the spent table covers the crash window before its ledger append.
  return Math.max(Number(spentRows?.total ?? 0), ledgerTotal);
}

export class SqliteVoucherWallet implements VoucherWalletInterface {
  async list(): Promise<StoredVoucher[]> {
    const now = await conservativeNowSeconds();
    return withCoreDatabase(async (database) => {
      const rows = await database.getAllAsync<VoucherRow>(
        "SELECT voucher_id, voucher_json, inr_paise, expiry_seconds FROM vouchers WHERE CAST(expiry_seconds AS INTEGER) > ? ORDER BY CAST(expiry_seconds AS INTEGER) ASC, inr_paise ASC",
        Number(now),
      );
      return rows.map(decodeVoucherRow);
    });
  }

  async addIssued(items: StoredVoucher[]): Promise<void> {
    const validated = items.map((item) => parseStoredVoucher(item));
    if (validated.length === 0) return;
    await withCoreDatabase(async (database) => {
      await database.withTransactionAsync(async () => {
        for (const item of validated) {
          const id = item.voucher.voucherId;
          const existing = await database.getFirstAsync<{ voucher_id: string }>(
            "SELECT voucher_id FROM vouchers WHERE voucher_id = ? UNION ALL SELECT voucher_id FROM spent_vouchers WHERE voucher_id = ? UNION ALL SELECT voucher_id FROM received WHERE voucher_id = ? LIMIT 1",
            id,
            id,
            id,
          );
          if (existing) throw new Error(`Voucher ${id} has already been stored or spent.`);
          await database.runAsync(
            "INSERT INTO vouchers(voucher_id, voucher_json, inr_paise, expiry_seconds) VALUES(?, ?, ?, ?)",
            id,
            stringifyJson(item),
            item.voucher.inrPaise,
            item.voucher.expiry.toString(),
          );
        }
      });
    });
  }

  async selectForAmount(inrPaise: number): Promise<StoredVoucher[] | null> {
    const requestedPaise = paiseSchema.parse(inrPaise);
    await assertOfflineIntegrity();
    await assertLedgerHealthy();
    const limits = await getOfflineLimits();
    if (requestedPaise > limits.maxSinglePaymentPaise) {
      throw new OfflineSpendLimitError(0, limits.maxSinglePaymentPaise, requestedPaise, "single-payment");
    }
    const nowMs = await conservativeNowMs();
    const nowSeconds = Math.floor(nowMs / 1000);

    return withCoreDatabase(async (database) => {
      const spentPaise = await getRollingSpendTotal(database, nowMs);
      if (spentPaise + requestedPaise > limits.maxSpend24hPaise) {
        throw new OfflineSpendLimitError(spentPaise, limits.maxSpend24hPaise, requestedPaise);
      }
      const rows = await database.getAllAsync<VoucherRow>(
        "SELECT voucher_id, voucher_json, inr_paise, expiry_seconds FROM vouchers WHERE CAST(expiry_seconds AS INTEGER) > ? ORDER BY CAST(expiry_seconds AS INTEGER) ASC, inr_paise ASC",
        nowSeconds,
      );
      const available = rows.map(decodeVoucherRow);
      const selection = chooseExactChange(available, requestedPaise);
      if (selection) return selection;
      const denominations = available.map((item) => item.voucher.inrPaise).sort((left, right) => left - right);
      const total = denominations.reduce((sum, denomination) => sum + denomination, 0);
      throw new ExactChangeError(requestedPaise, denominations, total);
    });
  }

  async markSpent(voucherIds: Hex[], reqId: Hex): Promise<void> {
    const ids = voucherIds.map((id) => voucherIdSchema.parse(id));
    const parsedReqId = voucherIdSchema.parse(reqId);
    if (ids.length === 0 || new Set(ids.map((id) => id.toLowerCase())).size !== ids.length) {
      throw new Error("A spend must include unique voucher IDs.");
    }

    await assertOfflineIntegrity();
    await assertLedgerHealthy();
    const limits = await getOfflineLimits();
    const nowMs = await conservativeNowMs();
    const nowSeconds = Math.floor(nowMs / 1000);
    const spentItems = await withCoreDatabase(async (database) => {
      let selected: StoredVoucher[] = [];
      await database.withTransactionAsync(async () => {
        const rollingTotal = await getRollingSpendTotal(database, nowMs);
        let requestedPaise = 0;
        const items: StoredVoucher[] = [];
        for (const id of ids) {
          const row = await database.getFirstAsync<VoucherRow>(
            "SELECT voucher_id, voucher_json, inr_paise, expiry_seconds FROM vouchers WHERE voucher_id = ?",
            id,
          );
          if (!row) throw new Error(`Voucher ${id} is not available to spend.`);
          const item = decodeVoucherRow(row);
          if (item.voucher.expiry <= BigInt(nowSeconds)) throw new Error(`Voucher ${id} has expired.`);
          requestedPaise += item.voucher.inrPaise;
          items.push(item);
        }
        if (requestedPaise > limits.maxSinglePaymentPaise) {
          throw new OfflineSpendLimitError(rollingTotal, limits.maxSinglePaymentPaise, requestedPaise, "single-payment");
        }
        if (rollingTotal + requestedPaise > limits.maxSpend24hPaise) {
          throw new OfflineSpendLimitError(rollingTotal, limits.maxSpend24hPaise, requestedPaise);
        }
        for (const item of items) {
          const id = item.voucher.voucherId;
          await database.runAsync(
            "INSERT INTO spent_vouchers(voucher_id, voucher_json, req_id, spent_at_ms, inr_paise) VALUES(?, ?, ?, ?, ?)",
            id,
            stringifyJson(item),
            parsedReqId,
            nowMs,
            item.voucher.inrPaise,
          );
          await database.runAsync("DELETE FROM vouchers WHERE voucher_id = ?", id);
        }
        selected = items;
      });
      return selected;
    });

    // Spend rows are committed before returning control to P7 so interruption cannot make these notes reusable.
    const ledgerPayload = {
      kind: "offline_spend",
      reqId: parsedReqId,
      voucherIds: spentItems.map((item) => item.voucher.voucherId),
      inrPaise: spentItems.reduce((sum, item) => sum + item.voucher.inrPaise, 0),
      spentAtMs: nowMs,
    };
    await ledgerService.append(ledgerPayload);
  }

  async offlineBalancePaise(): Promise<bigint> {
    const nowSeconds = await conservativeNowSeconds();
    return withCoreDatabase(async (database) => {
      const row = await database.getFirstAsync<{ total: number | null }>(
        "SELECT COALESCE(SUM(inr_paise), 0) AS total FROM vouchers WHERE CAST(expiry_seconds AS INTEGER) > ?",
        Number(nowSeconds),
      );
      return BigInt(row?.total ?? 0);
    });
  }
}

export const voucherWallet = new SqliteVoucherWallet();
