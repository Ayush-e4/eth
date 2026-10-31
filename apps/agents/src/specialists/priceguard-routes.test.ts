import { Hono } from "hono";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import { signedHeaders } from "../auth";
import { JsonStore } from "../store";
import type { Watch } from "./priceguard";
import { guardRoutes } from "./priceguard-routes";

const buyer = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());

function setUp() {
  const store = new JsonStore<Watch>();
  store.set("guard-b1", {
    task: "guard-b1",
    bookingId: "b1",
    buyer: buyer.address,
    stayEndpoint: "http://stay",
    stayAgent: "0x0000000000000000000000000000000000000001",
    slip: { body: { minSavingInr: 500, minSavingPercent: 5, until: "2026-12-04" } } as never,
    status: "watching",
    invoices: [],
  });
  const check = vi.fn(
    async (w: Watch) => ({ ...w, checks: [{ outcome: "not worth it yet" }] }) as never,
  );
  const app = new Hono();
  guardRoutes(app, { store, check });
  const call = async (who: typeof buyer, action: string) => {
    const path = `/watches/guard-b1/${action}`;
    const res = await app.request(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(await signedHeaders(who, "POST", path, "")),
      },
    });
    return { status: res.status, body: (await res.json()) as { watch?: Record<string, unknown> } };
  };
  return { store, check, call };
}

describe("PriceGuard, for the agent that set it up", () => {
  it("shows its limits and checks, to the buyer only", async () => {
    const { call } = setUp();
    expect((await call(stranger, "view")).status).toBe(403);
    expect((await call(buyer, "view")).body.watch).toMatchObject({
      bookingId: "b1",
      status: "watching",
      limits: { minSavingInr: 500 },
      checks: [],
    });
  });

  it("checks now at most once a minute, and stops when asked", async () => {
    const { call, check, store } = setUp();
    expect((await call(buyer, "check-now")).body.watch).toMatchObject({
      checks: [{ outcome: "not worth it yet" }],
    });
    expect((await call(buyer, "check-now")).status).toBe(429);
    expect(check).toHaveBeenCalledOnce();
    expect((await call(buyer, "stop")).body.watch).toMatchObject({ status: "stopped" });
    expect(store.get("guard-b1")?.status).toBe("stopped");
  });
});
