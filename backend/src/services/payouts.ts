import { randomUUID } from "node:crypto";
import type { FiatGateway } from "../gateways/fiat.js";
import type { BackendDatabase } from "../db/database.js";

export async function createMockPayout(
  db: BackendDatabase,
  gateway: FiatGateway,
  input: { userId: string; deviceId: string; amountInrPaise: number; vpa: string },
): Promise<{ payoutId: string; status: string }> {
  const payoutId = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const result = await gateway.createPayout({ payoutId, amountInrPaise: input.amountInrPaise, vpa: input.vpa });
  db.prepare(`
    INSERT INTO payouts (id, user_id, device_id, amount_inr_paise, vpa, status, gateway_reference, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(payoutId, input.userId, input.deviceId, input.amountInrPaise, input.vpa, result.status, result.reference, now, now);
  return { payoutId, status: result.status };
}
