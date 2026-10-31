import { Hono } from "hono";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signedHeaders } from "../auth";
import { JsonStore } from "../store";
import { farewatch, type Watch, WatchInput } from "./farewatch";
import type { SpecialistKit } from "./server";

vi.mock("@eth/arkiv", () => ({
  jobsForTask: vi.fn(async () => [{ record: { seller: AGENT, buyer: BUYER, quote: "0xw1" } }]),
}));

const AGENT = privateKeyToAccount(generatePrivateKey()).address;
const buyer = privateKeyToAccount(generatePrivateKey());
const BUYER = buyer.address;
const stranger = privateKeyToAccount(generatePrivateKey());

const offer = (total: number) => ({
  offerId: "o",
  total,
  currency: "INR",
  outbound: {
    carrier: "IndiGo",
    flightNumber: "6E5061",
    origin: "BOM",
    destination: "GOX",
    departAt: "2026-12-04T19:50:00",
    arriveAt: "2026-12-04T21:00:00",
    stops: 0,
  },
});

let price: number;
let clock: number;
let store: JsonStore<Watch>;
beforeEach(() => {
  price = 3267;
  clock = Date.parse("2026-11-01T10:00:00Z");
  store = new JsonStore<Watch>();
});

async function setUp(input: Partial<Parameters<typeof WatchInput.parse>[0]> = {}) {
  const def = farewatch({
    search: async () => [offer(price)],
    store,
    arkiv: {} as never,
    simulate: true,
    now: () => clock,
  });
  const req = {
    task: "t1",
    skill: "farewatch",
    quoteKey: "0xw1",
    input: WatchInput.parse({ origin: "BOM", destination: "GOI", date: "2026-12-04", ...input }),
  };
  const q = await def.quote(req);
  await def.work(req, q.detail);
  const app = new Hono();
  def.extend?.(app, { ctx: { identity: { evm: AGENT } } } as unknown as SpecialistKit);
  const call = async (who: typeof buyer, action: string, body: unknown = {}) => {
    const path = `/watches/0xw1/${action}`;
    const text = JSON.stringify(body);
    const res = await app.request(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(await signedHeaders(who, "POST", path, text)),
      },
      body: text,
    });
    return { status: res.status, watch: ((await res.json()) as { watch?: Watch }).watch };
  };
  return { q, call };
}

describe("FareWatch", () => {
  it("quotes the fare it will watch and starts from it; only the buyer can look", async () => {
    const { q, call } = await setUp({ targetInr: 3000 });
    expect(q.note).toContain("tell you at ₹3,000 or less");
    expect((await call(stranger, "view")).status).toBe(403);
    expect((await call(buyer, "view")).watch).toMatchObject({
      status: "watching",
      baseline: { price: 3267 },
      checks: [expect.objectContaining({ price: 3267 })],
      alerts: [],
    });
  });

  it("with a target: tells once when the fare reaches it, not before", async () => {
    const { call } = await setUp({ targetInr: 3000 });
    price = 3100;
    clock += 120_000;
    expect((await call(buyer, "check-now")).watch?.alerts).toEqual([]);
    price = 2990;
    clock += 120_000;
    const w = (await call(buyer, "check-now")).watch;
    expect(w?.alerts).toEqual([
      expect.objectContaining({
        price: 2990,
        was: 3100,
        reason: "at or below your target of ₹3,000",
      }),
    ]);
    expect(w?.lowest.price).toBe(2990);
    clock += 120_000;
    expect((await call(buyer, "check-now")).watch?.alerts).toHaveLength(1); // same price: no repeat
  });

  it("without a target: tells on a 3% drop; a simulated one says so", async () => {
    const { call } = await setUp();
    const w = (await call(buyer, "simulate", { percent: 10 })).watch;
    expect(w?.alerts).toEqual([
      expect.objectContaining({
        price: 2940,
        simulated: true,
        reason: "10% under the lowest so far",
      }),
    ]);
    expect((await call(buyer, "check-now")).status).toBe(200);
    expect((await call(buyer, "check-now")).status).toBe(429); // at most once a minute
  });

  it("stops when asked, and ends when its time is up", async () => {
    const { call } = await setUp({ hours: 1 });
    clock += 2 * 3_600_000;
    expect((await call(buyer, "check-now")).watch?.status).toBe("ended");
    expect((await call(buyer, "stop")).watch?.status).toBe("stopped");
  });
});
