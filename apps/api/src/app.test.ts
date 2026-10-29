import { HealthSchema } from "@eth/shared";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { testDb } from "./test/db";

describe("GET /health", () => {
  it("responds 200 with a valid health payload", async () => {
    const app = createApp(await testDb(), loadConfig({ NODE_ENV: "test" }));
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(HealthSchema.parse(await res.json()).service).toBe("api");
  });
});
