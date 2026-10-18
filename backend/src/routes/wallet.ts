import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { authFromResponse, createAuthMiddleware } from "../auth.js";
import type { AppContext } from "../context.js";
import { HttpError, parse } from "../http.js";

const ledgerSchema = z.object({
  headHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  counter: z.number().int().nonnegative().safe(),
}).strict();
const vpaSchema = z.object({ vpa: z.string().trim().regex(/^[A-Za-z0-9._-]{2,256}@[A-Za-z0-9.-]{2,64}$/) }).strict();

export function walletRoutes(context: AppContext): Router {
  const router = Router();
  const authenticate = createAuthMiddleware(context.env, context.db);

  router.get("/v1/wallet", authenticate, (_request, response) => {
    const auth = authFromResponse(response);
    const funded = context.db.prepare("SELECT amount_inr_paise FROM orders WHERE device_id = ? AND status = 'funded'").all(auth.deviceId) as { amount_inr_paise: number }[];
    const vouchers = context.db.prepare("SELECT inr_paise, status FROM vouchers WHERE device_id = ?").all(auth.deviceId) as { inr_paise: number; status: string }[];
    const totalFunded = funded.reduce((sum, row) => sum + row.amount_inr_paise, 0);
    const allIssued = vouchers.reduce((sum, row) => sum + row.inr_paise, 0);
    const offlineUnspent = vouchers.filter((row) => row.status === "issued").reduce((sum, row) => sum + row.inr_paise, 0);
    const pendingSettlement = context.db.prepare("SELECT inr_paise FROM received_items WHERE payee_device_id = ? AND status = 'pending'").all(auth.deviceId) as { inr_paise: number }[];
    response.json({
      onlineInrPaise: Math.max(0, totalFunded - allIssued),
      offlineIssuedUnspentPaise: offlineUnspent,
      pendingSettlementPaise: pendingSettlement.reduce((sum, row) => sum + row.inr_paise, 0),
    });
  });

  router.get("/v1/wallet/history", authenticate, (_request, response) => {
    const auth = authFromResponse(response);
    const rows = context.db.prepare(`
      SELECT id, 'onramp' AS type, amount_inr_paise AS amountInrPaise, status, created_at AS createdAt FROM orders WHERE device_id = ?
      UNION ALL
      SELECT id, 'voucher' AS type, inr_paise AS amountInrPaise, status, created_at AS createdAt FROM vouchers WHERE device_id = ?
      UNION ALL
      SELECT id, 'payout' AS type, amount_inr_paise AS amountInrPaise, status, created_at AS createdAt FROM payouts WHERE device_id = ?
      ORDER BY createdAt DESC LIMIT 100
    `).all(auth.deviceId, auth.deviceId, auth.deviceId) as { id: string; type: string; amountInrPaise: number; status: string; createdAt: number }[];
    response.json({ items: rows });
  });

  router.get("/v1/payouts", authenticate, (_request, response) => {
    const auth = authFromResponse(response);
    const rows = context.db.prepare(`
      SELECT id AS payoutId, amount_inr_paise AS amountInrPaise, vpa, status, gateway_reference AS gatewayReference, created_at AS createdAt
      FROM payouts WHERE user_id = ? AND device_id = ? ORDER BY created_at DESC LIMIT 100
    `).all(auth.userId, auth.deviceId) as { payoutId: string; amountInrPaise: number; vpa: string; status: string; gatewayReference: string | null; createdAt: number }[];
    response.json({ payouts: rows });
  });

  router.post("/v1/payee/vpa", authenticate, (request, response) => {
    const auth = authFromResponse(response);
    const body = parse(vpaSchema, request.body as unknown);
    context.db.prepare("UPDATE devices SET payee_vpa = ?, last_seen = ? WHERE id = ?")
      .run(body.vpa, Math.floor(Date.now() / 1000), auth.deviceId);
    response.json({ vpa: body.vpa });
  });

  router.post("/v1/ledger/head", authenticate, async (request, response) => {
    const auth = authFromResponse(response);
    const body = parse(ledgerSchema, request.body as unknown);
    const device = context.db.prepare("SELECT address, ledger_head_hash, ledger_counter, frozen FROM devices WHERE id = ?").get(auth.deviceId) as
      | { address: `0x${string}`; ledger_head_hash: string | null; ledger_counter: number; frozen: number }
      | undefined;
    if (!device) throw new HttpError(404, "DEVICE_NOT_FOUND", "The authenticated device no longer exists.");
    const regressed = body.counter < device.ledger_counter ||
      (body.counter === device.ledger_counter && device.ledger_head_hash !== null && body.headHash.toLowerCase() !== device.ledger_head_hash.toLowerCase());
    const now = Math.floor(Date.now() / 1000);
    if (regressed) {
      const details = { previousCounter: device.ledger_counter, previousHash: device.ledger_head_hash, counter: body.counter, headHash: body.headHash };
      const record = context.db.transaction(() => {
        context.db.prepare("UPDATE devices SET frozen = 1, revoked_at = COALESCE(revoked_at, ?), last_seen = ? WHERE id = ?").run(now, now, auth.deviceId);
        context.db.prepare("INSERT INTO audit_log (id, actor_device_id, event_type, subject, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
          .run(randomUUID(), auth.deviceId, "ledger_regression", device.address, JSON.stringify(details), now);
        context.db.prepare("INSERT INTO double_spend_attempts (id, device_id, voucher_id, reason, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(randomUUID(), auth.deviceId, `ledger:${body.headHash}`, "ledger head counter regression or same-counter hash change", now);
      });
      record();
      await context.chain.freeze(device.address);
      response.status(409).json({ ok: false, flagged: true, message: "Ledger head regressed; this device has been frozen and revoked." });
      return;
    }
    if (device.frozen) {
      response.status(403).json({ ok: false, flagged: true, message: "This device is frozen." });
      return;
    }
    context.db.prepare("UPDATE devices SET ledger_head_hash = ?, ledger_counter = ?, last_seen = ? WHERE id = ?")
      .run(body.headHash.toLowerCase(), body.counter, now, auth.deviceId);
    response.json({ ok: true, flagged: false });
  });

  return router;
}
