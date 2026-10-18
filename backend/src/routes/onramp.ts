import { randomUUID } from "node:crypto";
import { Router, type Request } from "express";
import { z } from "zod";
import { createAuthMiddleware, authFromResponse } from "../auth.js";
import type { AppContext } from "../context.js";
import { HttpError, parse, uuidSchema } from "../http.js";
import type { FiatWebhookEvent } from "../gateways/fiat.js";
import { logger } from "../logger.js";

const createOrderSchema = z.object({ amountInr: z.number().int().positive().safe() }).strict();
const webhookSchema = z.object({
  eventId: z.string().uuid(),
  orderId: z.string().uuid(),
  status: z.enum(["paid", "failed"]),
  amountInrPaise: z.number().int().positive().safe(),
}).strict();
const actionSchema = z.object({ result: z.enum(["paid", "failed"]) }).strict();

function rawBodyOf(request: Request): Buffer {
  return request.rawBody ?? Buffer.from(JSON.stringify(request.body), "utf8");
}

async function deliverWebhook(context: AppContext, rawBody: Buffer, signature: string, eventValue: unknown): Promise<{ accepted: true; replayed: boolean }> {
  const event = parse(webhookSchema, eventValue);
  if (!context.gateway.verifyWebhook(rawBody, signature)) throw new HttpError(401, "BAD_WEBHOOK_SIGNATURE", "The fiat webhook signature is invalid.");
  const existingEvent = context.db.prepare("SELECT event_id FROM webhook_events WHERE event_id = ?").get(event.eventId) as { event_id: string } | undefined;
  if (existingEvent) return { accepted: true, replayed: true };

  const order = context.db.prepare("SELECT id, device_id, amount_inr_paise, status FROM orders WHERE id = ?").get(event.orderId) as
    | { id: string; device_id: string; amount_inr_paise: number; status: string }
    | undefined;
  if (!order) throw new HttpError(404, "ORDER_NOT_FOUND", "The fiat webhook references an unknown order.");
  if (order.amount_inr_paise !== event.amountInrPaise) throw new HttpError(400, "AMOUNT_MISMATCH", "The webhook amount does not match the onramp order.");

  const now = Math.floor(Date.now() / 1000);
  const reserve = context.db.transaction(() => {
    const duplicate = context.db.prepare("SELECT event_id FROM webhook_events WHERE event_id = ?").get(event.eventId) as { event_id: string } | undefined;
    if (duplicate) return "replayed" as const;
    const latest = context.db.prepare("SELECT status FROM orders WHERE id = ?").get(order.id) as { status: string } | undefined;
    if (!latest || latest.status !== "pending") throw new HttpError(409, "ORDER_NOT_PENDING", "This onramp order has already been completed or is being processed.");
    context.db.prepare("INSERT INTO webhook_events (event_id, order_id, result, received_at) VALUES (?, ?, ?, ?)")
      .run(event.eventId, event.orderId, event.status, now);
    context.db.prepare("UPDATE orders SET status = ?, updated_at = ? WHERE id = ?")
      .run(event.status === "paid" ? "processing" : "failed", now, order.id);
    return "reserved" as const;
  });
  const reservation = reserve();
  if (reservation === "replayed") return { accepted: true, replayed: true };
  if (event.status === "failed") {
    context.db.prepare("INSERT INTO audit_log (id, actor_device_id, event_type, subject, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), order.device_id, "onramp_failed", order.id, JSON.stringify({ eventId: event.eventId }), now);
    return { accepted: true, replayed: false };
  }

  const device = context.db.prepare("SELECT address FROM devices WHERE id = ?").get(order.device_id) as { address: `0x${string}` } | undefined;
  if (!device) throw new HttpError(404, "DEVICE_NOT_FOUND", "The order device no longer exists.");
  const conversionNumerator = BigInt(order.amount_inr_paise) * 10000n;
  const conversionRate = BigInt(context.env.INR_PER_USDC);
  const usdcAmount = (conversionNumerator + conversionRate - 1n) / conversionRate;
  try {
    await context.chain.fundCollateral(device.address, usdcAmount);
    context.db.prepare("UPDATE orders SET funded_usdc_amount = ?, status = 'funded', updated_at = ? WHERE id = ?")
      .run(usdcAmount.toString(), Math.floor(Date.now() / 1000), order.id);
    context.db.prepare("INSERT INTO audit_log (id, actor_device_id, event_type, subject, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), order.device_id, "onramp_funded", order.id, JSON.stringify({ eventId: event.eventId, amountInrPaise: order.amount_inr_paise, usdcAmount: usdcAmount.toString() }), now);
  } catch (error) {
    // Keep the event reservation and processing state: retrying an uncertain chain result could fund twice.
    context.db.prepare("INSERT INTO audit_log (id, actor_device_id, event_type, subject, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), order.device_id, "onramp_funding_uncertain", order.id, JSON.stringify({ eventId: event.eventId, error: error instanceof Error ? error.name : "unknown" }), Math.floor(Date.now() / 1000));
    logger.error({ event: "onramp_funding_uncertain", orderId: order.id, error: error instanceof Error ? error.name : "unknown" });
    throw error;
  }
  return { accepted: true, replayed: false };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}

export function onrampRoutes(context: AppContext): Router {
  const router = Router();
  const issueRequests = new Set<string>();
  router.use("/v1/onramp", createAuthMiddleware(context.env, context.db));

  router.post("/v1/onramp/create", async (request, response) => {
    const auth = authFromResponse(response);
    const body = parse(createOrderSchema, request.body as unknown);
    const amountInrPaise = body.amountInr * 100;
    if (!Number.isSafeInteger(amountInrPaise) || amountInrPaise > context.env.MAX_OFFLINE_BALANCE_PAISE) {
      throw new HttpError(400, "AMOUNT_OUT_OF_RANGE", "amountInr must fit within the configured offline balance limit.");
    }
    const kyc = context.db.prepare("SELECT status FROM kyc WHERE user_id = ?").get(auth.userId) as { status: string } | undefined;
    if (kyc?.status !== "approved") throw new HttpError(403, "KYC_REQUIRED", "Approved KYC is required before creating an onramp order.");
    const id = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    context.db.prepare("INSERT INTO orders (id, user_id, device_id, amount_inr_paise, funded_usdc_amount, status, created_at, updated_at) VALUES (?, ?, ?, ?, '0', 'pending', ?, ?)")
      .run(id, auth.userId, auth.deviceId, amountInrPaise, now, now);
    try {
      const gatewayOrder = await context.gateway.createOnramp({ orderId: id, amountInrPaise });
      response.status(201).json({ orderId: id, paymentUrl: gatewayOrder.paymentUrl, status: gatewayOrder.status });
    } catch (error) {
      context.db.prepare("DELETE FROM orders WHERE id = ? AND status = 'pending'").run(id);
      throw error;
    }
  });

  router.get("/v1/onramp/:orderId", (request, response) => {
    const auth = authFromResponse(response);
    const orderId = parse(uuidSchema, request.params.orderId);
    const order = context.db.prepare("SELECT id, amount_inr_paise, status, created_at, updated_at FROM orders WHERE id = ? AND user_id = ? AND device_id = ?")
      .get(orderId, auth.userId, auth.deviceId) as { id: string; amount_inr_paise: number; status: string; created_at: number; updated_at: number } | undefined;
    if (!order) throw new HttpError(404, "ORDER_NOT_FOUND", "No onramp order was found for this device.");
    response.json({ orderId: order.id, amountInrPaise: order.amount_inr_paise, status: order.status, createdAt: order.created_at, updatedAt: order.updated_at });
  });

  router.post("/v1/vouchers/issue", createAuthMiddleware(context.env, context.db), async (request, response) => {
    const auth = authFromResponse(response);
    const body = parse(z.object({ orderId: z.string().uuid() }).strict(), request.body as unknown);
    const lock = `${auth.deviceId}:${body.orderId}`;
    if (issueRequests.has(lock)) throw new HttpError(409, "ISSUANCE_IN_PROGRESS", "Voucher issuance for this order is already in progress.");
    issueRequests.add(lock);
    try {
      const { issueVouchers } = await import("../services/vouchers.js");
      const vouchers = await issueVouchers(context.db, context.env, context.chain, context.issuerAccount, { ...body, userId: auth.userId, deviceId: auth.deviceId });
      response.status(201).json({ vouchers });
    } finally {
      issueRequests.delete(lock);
    }
  });

  router.post("/v1/webhooks/fiat", async (request, response) => {
    const signature = request.get("x-fiat-signature");
    if (!signature || !/^[a-fA-F0-9]{64}$/.test(signature)) throw new HttpError(401, "BAD_WEBHOOK_SIGNATURE", "A 32-byte X-Fiat-Signature is required.");
    const result = await deliverWebhook(context, rawBodyOf(request), signature, request.body as unknown);
    response.json(result);
  });

  router.get("/mock-upi/:orderId", (request, response) => {
    if (context.env.FIAT_GATEWAY !== "mock") throw new HttpError(404, "NOT_FOUND", "Mock UPI is disabled for the configured gateway.");
    const orderId = parse(uuidSchema, request.params.orderId);
    const order = context.db.prepare("SELECT id, amount_inr_paise, status FROM orders WHERE id = ?").get(orderId) as
      | { id: string; amount_inr_paise: number; status: string }
      | undefined;
    if (!order) throw new HttpError(404, "ORDER_NOT_FOUND", "No mock UPI order was found.");
    const rupees = Math.floor(order.amount_inr_paise / 100);
    const paise = String(order.amount_inr_paise % 100).padStart(2, "0");
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>OfflinePay Mock UPI</title></head><body><main><h1>Mock UPI payment</h1><p>Order ${escapeHtml(order.id)}</p><p>Amount: ₹${rupees}.${paise}</p><p>Status: ${escapeHtml(order.status)}</p><form method="post" action="/mock-upi/${encodeURIComponent(order.id)}/action"><input type="hidden" name="result" value="paid"><button type="submit">Pay</button></form><form method="post" action="/mock-upi/${encodeURIComponent(order.id)}/action"><input type="hidden" name="result" value="failed"><button type="submit">Fail</button></form></main></body></html>`;
    response.type("html").send(html);
  });

  router.post("/mock-upi/:orderId/action", async (request, response) => {
    if (!(context.gateway instanceof Object) || context.env.FIAT_GATEWAY !== "mock" || !("signWebhook" in context.gateway)) {
      throw new HttpError(404, "NOT_FOUND", "Mock UPI is disabled for the configured gateway.");
    }
    const orderId = parse(uuidSchema, request.params.orderId);
    const action = parse(actionSchema, request.body as unknown);
    const order = context.db.prepare("SELECT id, amount_inr_paise FROM orders WHERE id = ?").get(orderId) as { id: string; amount_inr_paise: number } | undefined;
    if (!order) throw new HttpError(404, "ORDER_NOT_FOUND", "No mock UPI order was found.");
    const event: FiatWebhookEvent = { eventId: randomUUID(), orderId, status: action.result, amountInrPaise: order.amount_inr_paise };
    const signed = (context.gateway as typeof context.gateway & { signWebhook: (event: FiatWebhookEvent) => { rawBody: Buffer; signature: string } }).signWebhook(event);
    const result = await deliverWebhook(context, signed.rawBody, signed.signature, event);
    response.type("html").send(`<!doctype html><html><body><h1>${result.accepted ? "Mock payment submitted" : "Payment error"}</h1><p>${escapeHtml(action.result)}</p><a href="/v1/onramp/${encodeURIComponent(orderId)}">Return to order status</a></body></html>`);
  });

  return router;
}
