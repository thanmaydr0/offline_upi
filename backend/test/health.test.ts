import { describe, it } from "vitest";
import request from "supertest";
import { createTestApp } from "./helpers.js";

describe("GET /health", () => {
  it("returns a healthy status", async () => {
    const testContext = createTestApp();
    await request(testContext.app).get("/health").expect(200, { status: "ok" });
    testContext.db.close();
  });
});
