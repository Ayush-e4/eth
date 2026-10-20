import { HealthSchema } from "@eth/shared";
import { describe, expect, it } from "vitest";
import { app } from "./app";

describe("GET /health", () => {
  it("responds 200 with a valid health payload", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(HealthSchema.parse(await res.json()).service).toBe("api");
  });
});
