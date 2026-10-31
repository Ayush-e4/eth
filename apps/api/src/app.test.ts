import { HealthSchema } from "@eth/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { loadConfig } from "./config";
import type { Db } from "./db/client";
import { testDb } from "./test/db";

let db: Db;
// Setting up the in-memory database (migrations) is slow under a full parallel run: do it in
// a hook, like the other suites, not inside the test's own time limit.
beforeAll(async () => {
  db = await testDb();
});

describe("GET /health", () => {
  it("responds 200 with a valid health payload", async () => {
    const app = createApp(db, loadConfig({ NODE_ENV: "test" }));
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(HealthSchema.parse(await res.json()).service).toBe("api");
  });
});
