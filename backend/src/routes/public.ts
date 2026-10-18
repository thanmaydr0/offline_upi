import { randomUUID } from "node:crypto";
import { Router } from "express";
import type { Address } from "viem";
import { DENOMINATIONS_PAISE } from "@offline-pay/shared";
import { createAccessToken } from "../auth.js";
import type { AppContext } from "../context.js";
import { parse } from "../http.js";
import { logger } from "../logger.js";
import { z } from "zod";

const registerSchema = z.object({
  deviceAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  deviceName: z.string().trim().min(1).max(80),
  integrity: z.object({ rooted: z.boolean(), isDevice: z.boolean() }).strict(),
}).strict();

export function publicRoutes(context: AppContext): Router {
  const router = Router();

  router.get("/v1/config", (_request, response) => {
    const revokedDevices = (context.db.prepare(`
      SELECT address FROM devices WHERE rooted = 1 OR integrity_is_device = 0 OR frozen = 1 OR revoked_at IS NOT NULL ORDER BY address
    `).all() as { address: string }[]).map((row) => row.address);
    response.json({
      issuerAddress: context.issuerAddress,
      vaultAddress: context.env.VAULT_ADDRESS,
      usdcAddress: context.env.USDC_ADDRESS,
      chainId: context.env.CHAIN_ID,
      inrPerUsdc: context.env.INR_PER_USDC,
      denominations: DENOMINATIONS_PAISE,
      limits: {
        maxOfflineBalancePaise: context.env.MAX_OFFLINE_BALANCE_PAISE,
        maxSingleOfflinePaymentPaise: context.env.MAX_SINGLE_OFFLINE_PAYMENT_PAISE,
        maxOfflineSpend24hPaise: context.env.MAX_OFFLINE_SPEND_24H_PAISE,
        merchantMaxUnsettledPaise: context.env.MERCHANT_MAX_UNSETTLED_PAISE,
      },
      revokedDevices,
      serverTime: new Date().toISOString(),
    });
  });

  router.post("/v1/devices/register", (request, response) => {
    const body = parse(registerSchema, request.body);
    const address = body.deviceAddress.toLowerCase();
    const existing = context.db.prepare("SELECT id, user_id, rooted, integrity_is_device FROM devices WHERE address = ?").get(address) as
      | { id: string; user_id: string; rooted: number; integrity_is_device: number }
      | undefined;
    const now = Math.floor(Date.now() / 1000);
    const userId = existing?.user_id ?? randomUUID();
    const deviceId = existing?.id ?? randomUUID();
    const rooted = body.integrity.rooted || Boolean(existing?.rooted);
    const isDevice = body.integrity.isDevice && existing?.integrity_is_device !== 0;
    const register = context.db.transaction(() => {
      if (!existing) context.db.prepare("INSERT INTO users (id, created_at) VALUES (?, ?)").run(userId, now);
      if (existing) {
        context.db.prepare("UPDATE devices SET name = ?, rooted = ?, integrity_is_device = ?, last_seen = ? WHERE id = ?")
          .run(body.deviceName, Number(rooted), Number(isDevice), now, deviceId);
      } else {
        context.db.prepare(`
          INSERT INTO devices (id, user_id, address, name, rooted, integrity_is_device, frozen, ledger_counter, last_seen, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
        `).run(deviceId, userId, address, body.deviceName, Number(rooted), Number(isDevice), now, now);
      }
      context.db.prepare("INSERT INTO audit_log (id, actor_device_id, event_type, subject, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(randomUUID(), deviceId, "device_registered", address, JSON.stringify({ rooted, isDevice }), now);
    });
    register();

    if (rooted || !isDevice) {
      logger.warn({ event: "device_integrity_rejected", deviceId, rooted, isDevice });
      response.status(403).json({
        error: "DEVICE_INTEGRITY_FAILED",
        message: rooted ? "Rooted devices cannot register for OfflinePay." : "OfflinePay requires a physical device integrity result.",
        rooted,
        isDevice,
      });
      return;
    }
    const token = createAccessToken(context.env, { userId, deviceId, deviceAddress: address as Address });
    response.status(201).json({ userId, token });
  });

  return router;
}
