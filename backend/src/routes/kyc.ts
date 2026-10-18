import { Router } from "express";
import { createAuthMiddleware, authFromResponse } from "../auth.js";
import type { AppContext } from "../context.js";
import { randomUUID } from "node:crypto";

export function kycRoutes(context: AppContext): Router {
  const router = Router();
  const authenticate = createAuthMiddleware(context.env, context.db);

  router.post("/v1/kyc/start", authenticate, (_request, response) => {
    const auth = authFromResponse(response);
    const current = context.db.prepare("SELECT status, started_at, approved_at FROM kyc WHERE user_id = ?").get(auth.userId) as
      | { status: string; started_at: number; approved_at: number | null }
      | undefined;
    const now = Math.floor(Date.now() / 1000);
    if (!current) {
      context.db.prepare("INSERT INTO kyc (user_id, status, started_at) VALUES (?, 'pending', ?)").run(auth.userId, now);
      context.db.prepare("INSERT INTO audit_log (id, actor_device_id, event_type, subject, details_json, created_at) VALUES (?, ?, ?, ?, '{}', ?)")
        .run(randomUUID(), auth.deviceId, "kyc_started", auth.userId, now);
      const timer = setTimeout(() => {
        context.db.prepare("UPDATE kyc SET status = 'approved', approved_at = ? WHERE user_id = ? AND status = 'pending'")
          .run(Math.floor(Date.now() / 1000), auth.userId);
      }, context.kycApprovalDelayMs);
      timer.unref();
      response.status(202).json({ status: "pending", startedAt: now });
      return;
    }
    response.status(current.status === "approved" ? 200 : 202).json({ status: current.status, startedAt: current.started_at, approvedAt: current.approved_at });
  });

  router.get("/v1/kyc/status", authenticate, (_request, response) => {
    const auth = authFromResponse(response);
    const current = context.db.prepare("SELECT status, started_at, approved_at FROM kyc WHERE user_id = ?").get(auth.userId) as
      | { status: string; started_at: number; approved_at: number | null }
      | undefined;
    if (!current) {
      response.status(404).json({ error: "KYC_NOT_STARTED", message: "Start KYC before checking its status." });
      return;
    }
    response.json({ status: current.status, startedAt: current.started_at, approvedAt: current.approved_at });
  });

  return router;
}
