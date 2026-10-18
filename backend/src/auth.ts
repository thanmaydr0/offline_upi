import jwt from "jsonwebtoken";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import type { BackendEnv } from "./env.js";
import type { BackendDatabase } from "./db/database.js";
import { logger } from "./logger.js";

export type AuthContext = { userId: string; deviceId: string; deviceAddress: `0x${string}` };

const claimsSchema = z.object({
  sub: z.string().uuid(),
  deviceId: z.string().uuid(),
  deviceAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  iss: z.literal("offline-pay"),
});

export function createAccessToken(env: BackendEnv, auth: AuthContext): string {
  return jwt.sign(
    { deviceId: auth.deviceId, deviceAddress: auth.deviceAddress },
    env.JWT_SECRET,
    { subject: auth.userId, issuer: "offline-pay", expiresIn: "12h" },
  );
}

export function createAuthMiddleware(env: BackendEnv, db: BackendDatabase) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const header = request.get("authorization");
    if (!header?.startsWith("Bearer ")) {
      response.status(401).json({ error: "AUTH_REQUIRED", message: "Send a valid Bearer token." });
      return;
    }
    try {
      const decoded = jwt.verify(header.slice(7), env.JWT_SECRET, { issuer: "offline-pay" });
      if (typeof decoded === "string") throw new Error("Invalid token payload");
      const parsed = claimsSchema.safeParse(decoded);
      if (!parsed.success) throw new Error("Invalid token claims");
      const auth: AuthContext = {
        userId: parsed.data.sub,
        deviceId: parsed.data.deviceId,
        deviceAddress: parsed.data.deviceAddress as `0x${string}`,
      };
      const device = db.prepare("SELECT id, user_id, address, rooted, integrity_is_device FROM devices WHERE id = ?").get(auth.deviceId) as
        | { id: string; user_id: string; address: string; rooted: number; integrity_is_device: number }
        | undefined;
      if (!device || device.user_id !== auth.userId || device.address.toLowerCase() !== auth.deviceAddress.toLowerCase()) {
        response.status(401).json({ error: "AUTH_INVALID", message: "The token is no longer associated with this device." });
        return;
      }
      if (device.rooted || !device.integrity_is_device) {
        response.status(403).json({ error: "DEVICE_INTEGRITY_FAILED", message: "This device does not satisfy the required integrity checks." });
        return;
      }
      db.prepare("UPDATE devices SET last_seen = ? WHERE id = ?").run(Math.floor(Date.now() / 1000), auth.deviceId);
      response.locals.auth = auth;
      next();
    } catch (error) {
      logger.info({ event: "auth_rejected", reason: error instanceof Error ? error.name : "unknown" });
      response.status(401).json({ error: "AUTH_INVALID", message: "The Bearer token is invalid or expired." });
    }
  };
}

export function authFromResponse(response: Response): AuthContext {
  return response.locals.auth as AuthContext;
}
