import type { Hex, PaymentProof, ProofItem } from "@offline-pay/shared";
import { z } from "zod";
import { withCoreDatabase } from "./database";
import { parsePaymentProof, parseProofItem, parseJson, stringifyJson } from "./schema";
import type { ReceivedStore as ReceivedStoreInterface } from "../services/types";

const voucherIdSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((value) => value.toLowerCase() as Hex);
const statusSchema = z.number().int().min(0).max(255).safe();
type ReceivedRow = { voucher_id: string; proof_item_json: string; status: string; settlement_status: number | null };

export class SqliteReceivedStore implements ReceivedStoreInterface {
  async addVerified(proof: PaymentProof): Promise<void> {
    const validated = parsePaymentProof(proof);
    const items = validated.items.map((item) => parseProofItem(item));
    const ids = items.map((item) => item.voucher.voucherId.toLowerCase());
    if (new Set(ids).size !== ids.length) throw new Error("A received proof contains duplicate voucher IDs.");

    await withCoreDatabase(async (database) => {
      await database.withTransactionAsync(async () => {
        for (const item of items) {
          const id = item.voucher.voucherId;
          const duplicate = await database.getFirstAsync<{ voucher_id: string }>(
            "SELECT voucher_id FROM received WHERE voucher_id = ? UNION ALL SELECT voucher_id FROM vouchers WHERE voucher_id = ? UNION ALL SELECT voucher_id FROM spent_vouchers WHERE voucher_id = ? LIMIT 1",
            id,
            id,
            id,
          );
          if (duplicate) throw new Error(`Voucher ${id} has already been seen on this device.`);
          await database.runAsync(
            "INSERT INTO received(voucher_id, proof_item_json, status, settlement_status, received_at_ms) VALUES(?, ?, 'pending', NULL, ?)",
            id,
            stringifyJson(item),
            Date.now(),
          );
        }
        // Commit the original proof with its credits, so an interrupted Bluetooth
        // acknowledgement can be retried even after restart or online settlement.
        await database.runAsync(
          'INSERT INTO core_meta(key, value) VALUES(?, ?)',
          `received-proof:${validated.reqId.toLowerCase()}`,
          stringifyJson(validated),
        );
      });
    });
  }

  async findVerified(reqId: Hex): Promise<PaymentProof | null> {
    const id = z.string().regex(/^0x[0-9a-fA-F]{32}$/).parse(reqId).toLowerCase();
    return withCoreDatabase(async database => {
      const row = await database.getFirstAsync<{ value: string }>('SELECT value FROM core_meta WHERE key = ?', `received-proof:${id}`);
      return row ? parsePaymentProof(parseJson<unknown>(row.value)) : null;
    });
  }

  async pending(): Promise<ProofItem[]> {
    return withCoreDatabase(async (database) => {
      const rows = await database.getAllAsync<ReceivedRow>(
        "SELECT voucher_id, proof_item_json, status, settlement_status FROM received WHERE status = 'pending' ORDER BY received_at_ms ASC",
      );
      return rows.map((row) => parseProofItem(parseJson<unknown>(row.proof_item_json)));
    });
  }

  async markSettled(voucherId: Hex, status: number): Promise<void> {
    const id = voucherIdSchema.parse(voucherId);
    const resultStatus = statusSchema.parse(status);
    await withCoreDatabase(async (database) => {
      const result = await database.runAsync(
        "UPDATE received SET status = 'settled', settlement_status = ? WHERE voucher_id = ? AND status = 'pending'",
        resultStatus,
        id,
      );
      if (result.changes !== 1) throw new Error(`Pending received voucher ${id} was not found.`);
    });
  }

  async seenVoucher(id: Hex): Promise<boolean> {
    const voucherId = voucherIdSchema.parse(id);
    return withCoreDatabase(async (database) => {
      const row = await database.getFirstAsync<{ voucher_id: string }>(
        "SELECT voucher_id FROM received WHERE voucher_id = ? UNION ALL SELECT voucher_id FROM vouchers WHERE voucher_id = ? UNION ALL SELECT voucher_id FROM spent_vouchers WHERE voucher_id = ? LIMIT 1",
        voucherId,
        voucherId,
        voucherId,
      );
      return row !== null;
    });
  }
}

export const receivedStore = new SqliteReceivedStore();
