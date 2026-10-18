import { describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";

describe("GET /health", () => {
  it("returns a healthy status", async () => {
    await request(app).get("/health").expect(200, { status: "ok" });
  });
});
