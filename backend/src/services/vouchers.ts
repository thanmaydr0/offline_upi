import { randomBytes, randomUUID } from "node:crypto";
import type { Address, Hex } from "viem";
import type { privateKeyToAccount } from "viem/accounts";
import { DENOMINATIONS_PAISE, VOUCHER_TYPES } from "@offline-pay/shared";
import type { BackendDatabase } from "../db/database.js";
import type { BackendEnv } from "../env.js";
import { HttpError } from "../http.js";
import type { ChainClient } from "../chain/types.js";

type IssueRequest = { orderId: string; userId: string; deviceId: string };
type IssuedVoucher = {
  voucher: { voucherId: Hex; device: Address; usdcAmount: string; inrPaise: number; expiry: string };
  issuerSig: Hex;
};

function greedyWithVariety(amountInrPaise: number): number[] {
  let remaining = amountInrPaise;
  const result: number[] = [];
  for (const denomination of [...DENOMINATIONS_PAISE].reverse()) {
    if (remaining >= denomination) {
      result.push(denomination);
      remaining -= denomination;
    }
  }
  for (const denomination of [...DENOMINATIONS_PAISE].reverse()) {
    while (remaining >= denomination) {
      result.push(denomination);
      remaining -= denomination;
    }
  }
  if (remaining !== 0) throw new Error("Unable to exactly represent requested voucher amount.");
  return result;
}

function sumBigints(values: readonly { usdc_amount: string }[]): bigint {
  return values.reduce((total, row) => total + BigInt(row.usdc_amount), 0n);
}

export async function issueVouchers(
  db: BackendDatabase,
  env: BackendEnv,
  chain: ChainClient,
  issuerAccount: ReturnType<typeof privateKeyToAccount>,
  input: IssueRequest,
): Promise<IssuedVoucher[]> {
  const order = db.prepare(`
    SELECT o.id, o.user_id, o.device_id, o.amount_inr_paise, o.funded_usdc_amount, o.status,
           d.address, d.rooted, d.frozen
    FROM orders o JOIN devices d ON d.id = o.device_id
    WHERE o.id = ? AND o.user_id = ? AND o.device_id = ?
  `).get(input.orderId, input.userId, input.deviceId) as
    | { id: string; user_id: string; device_id: string; amount_inr_paise: number; funded_usdc_amount: string; status: string; address: Address; rooted: number; frozen: number }
    | undefined;
  if (!order) throw new HttpError(404, "ORDER_NOT_FOUND", "No onramp order was found for this device.");
  if (order.rooted) throw new HttpError(403, "ROOTED_DEVICE", "Vouchers cannot be issued to a rooted or non-device integrity result.");
  if (order.frozen) throw new HttpError(403, "DEVICE_FROZEN", "Vouchers cannot be issued to a frozen device.");
  if (order.status !== "funded") throw new HttpError(409, "ORDER_NOT_FUNDED", "The order must be funded before vouchers can be issued.");

  const alreadyIssuedForOrder = db.prepare("SELECT inr_paise, usdc_amount FROM vouchers WHERE order_id = ?").all(order.id) as { inr_paise: number; usdc_amount: string }[];
  const alreadyIssuedForDevice = db.prepare("SELECT inr_paise, usdc_amount FROM vouchers WHERE device_id = ? AND status IN ('issued', 'spent')").all(order.device_id) as { inr_paise: number; usdc_amount: string }[];
  const issuedOrderPaise = alreadyIssuedForOrder.reduce((sum, row) => sum + row.inr_paise, 0);
  const activeIssuedPaise = alreadyIssuedForDevice.reduce((sum, row) => sum + row.inr_paise, 0);
  const activeIssuedUsdc = sumBigints(alreadyIssuedForDevice);
  const collateral = await chain.getCollateral(order.address);
  const remainingCollateral = collateral > activeIssuedUsdc ? collateral - activeIssuedUsdc : 0n;
  const collateralPaise = (remainingCollateral * BigInt(env.INR_PER_USDC)) / 10000n;
  const remainingBalanceLimit = Math.max(0, env.MAX_OFFLINE_BALANCE_PAISE - activeIssuedPaise);
  const orderRemainingPaise = Math.max(0, order.amount_inr_paise - issuedOrderPaise);
  const amountToIssue = Number([BigInt(orderRemainingPaise), collateralPaise, BigInt(remainingBalanceLimit)].reduce((left, right) => left < right ? left : right));
  const denominations = amountToIssue >= 100 ? greedyWithVariety(amountToIssue - (amountToIssue % 100)) : [];
  if (denominations.length === 0) throw new HttpError(409, "NO_UNISSUED_COLLATERAL", "No funded collateral is available for new vouchers.");

  const now = Math.floor(Date.now() / 1000);
  const domain = { name: "OfflineVault", version: "1", chainId: env.CHAIN_ID, verifyingContract: env.VAULT_ADDRESS as Address } as const;
  const issued: IssuedVoucher[] = [];
  const rows: { id: string; voucherId: Hex; inrPaise: number; usdcAmount: bigint; expiry: bigint; signature: Hex }[] = [];
  for (const inrPaise of denominations) {
    const voucher = {
      voucherId: `0x${randomBytes(32).toString("hex")}` as Hex,
      device: order.address,
      usdcAmount: (BigInt(inrPaise) * 10000n) / BigInt(env.INR_PER_USDC),
      inrPaise,
      expiry: BigInt(now + env.VOUCHER_TTL_SECONDS),
    };
    const issuerSig = await issuerAccount.signTypedData({ domain, types: VOUCHER_TYPES, primaryType: "Voucher", message: voucher });
    const output: IssuedVoucher = {
      voucher: { ...voucher, usdcAmount: voucher.usdcAmount.toString(), expiry: voucher.expiry.toString() },
      issuerSig,
    };
    rows.push({ id: randomUUID(), voucherId: voucher.voucherId, inrPaise, usdcAmount: voucher.usdcAmount, expiry: voucher.expiry, signature: issuerSig });
    issued.push(output);
  }
  const insert = db.prepare(`
    INSERT INTO vouchers (id, voucher_id, device_id, order_id, inr_paise, usdc_amount, expiry, signature, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'issued', ?)
  `);
  const totalPlannedPaise = rows.reduce((sum, row) => sum + row.inrPaise, 0);
  const totalPlannedUsdc = rows.reduce((sum, row) => sum + row.usdcAmount, 0n);
  const insertAll = db.transaction(() => {
    const latestOrder = db.prepare("SELECT amount_inr_paise, status FROM orders WHERE id = ?").get(order.id) as { amount_inr_paise: number; status: string } | undefined;
    if (!latestOrder || latestOrder.status !== "funded") throw new HttpError(409, "ORDER_NOT_FUNDED", "The order is no longer funded.");
    const latestOrderVouchers = db.prepare("SELECT inr_paise FROM vouchers WHERE order_id = ?").all(order.id) as { inr_paise: number }[];
    const latestOrderPaise = latestOrderVouchers.reduce((sum, row) => sum + row.inr_paise, 0);
    if (latestOrderPaise + totalPlannedPaise > latestOrder.amount_inr_paise) throw new HttpError(409, "NO_UNISSUED_COLLATERAL", "The funded order has already been issued.");
    const latestActive = db.prepare("SELECT inr_paise, usdc_amount FROM vouchers WHERE device_id = ? AND status IN ('issued', 'spent')").all(order.device_id) as { inr_paise: number; usdc_amount: string }[];
    const latestActivePaise = latestActive.reduce((sum, row) => sum + row.inr_paise, 0);
    if (latestActivePaise + totalPlannedPaise > env.MAX_OFFLINE_BALANCE_PAISE || sumBigints(latestActive) + totalPlannedUsdc > collateral) {
      throw new HttpError(409, "NO_UNISSUED_COLLATERAL", "The available collateral or offline balance limit changed before issuance.");
    }
    for (const row of rows) insert.run(row.id, row.voucherId, order.device_id, order.id, row.inrPaise, row.usdcAmount.toString(), row.expiry.toString(), row.signature, now);
    db.prepare("INSERT INTO audit_log (id, actor_device_id, event_type, subject, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), order.device_id, "vouchers_issued", order.id, JSON.stringify({ count: rows.length, inrPaise: denominations.reduce((sum, amount) => sum + amount, 0) }), now);
  });
  insertAll();
  return issued;
}
