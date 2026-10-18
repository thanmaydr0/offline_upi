import { createHmac, timingSafeEqual } from "node:crypto";
import type { Address } from "viem";
import type { BackendEnv } from "../env.js";
import { OnrampMoneyGateway } from "./onramp.js";
export { OnrampMoneyGateway } from "./onramp.js";

export type OnrampOrder = { orderId: string; amountInrPaise: number };
export type FiatWebhookEvent = {
  eventId: string;
  orderId: string;
  status: "paid" | "failed";
  amountInrPaise: number;
};
export type SignedWebhook = { rawBody: Buffer; signature: string };
export type GatewayPayout = { reference: string; status: "pending" | "paid" | "failed" };

export interface FiatGateway {
  createOnramp(order: OnrampOrder): Promise<{ paymentUrl: string; status: "pending" }>;
  verifyWebhook(rawBody: Buffer, signature: string): boolean;
  createPayout(input: { payoutId: string; amountInrPaise: number; vpa: string }): Promise<GatewayPayout>;
}

export class MockGateway implements FiatGateway {
  constructor(private readonly webhookSecret: string) {}

  async createOnramp(order: OnrampOrder): Promise<{ paymentUrl: string; status: "pending" }> {
    return { paymentUrl: `/mock-upi/${encodeURIComponent(order.orderId)}`, status: "pending" };
  }

  signWebhook(event: FiatWebhookEvent): SignedWebhook {
    const rawBody = Buffer.from(JSON.stringify(event), "utf8");
    return { rawBody, signature: this.signature(rawBody) };
  }

  verifyWebhook(rawBody: Buffer, signature: string): boolean {
    const expected = Buffer.from(this.signature(rawBody));
    const received = Buffer.from(signature);
    return expected.length === received.length && timingSafeEqual(expected, received);
  }

  async createPayout(input: { payoutId: string; amountInrPaise: number; vpa: string }): Promise<GatewayPayout> {
    return { reference: `mock-${input.payoutId}`, status: "pending" };
  }

  private signature(rawBody: Buffer): string {
    return createHmac("sha256", this.webhookSecret).update(rawBody).digest("hex");
  }
}

export function createFiatGateway(mode: "mock" | "onramp", secret: string, env?: BackendEnv): FiatGateway {
  return mode === "mock" ? new MockGateway(secret) : new OnrampMoneyGateway(env);
}

export type PayoutRequest = {
  userId: string;
  deviceId: string;
  deviceAddress: Address;
  amountInrPaise: number;
  vpa: string;
};
