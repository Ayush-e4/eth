import { createPayingFetch, type Facilitator, MirrorResolver } from "@eth/x402";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signedHeaders } from "../auth";
import { JsonStore } from "../store";
import { jobStore } from "./jobs";
import { createSpecialist } from "./server";
import { skyhop } from "./skyhop";
import type { FlightRecord } from "./skyhop-manage";

let n = 0;
vi.mock("@eth/arkiv", () => ({
  arkivReader: vi.fn(() => ({})),
  arkivWriter: vi.fn(() => ({})),
  postQuote: vi.fn(async () => ({ entityKey: `0xq${++n}` })),
  findListings: vi.fn(async () => []),
  publishAgent: vi.fn(async () => ({})),
  recordDelivery: vi.fn(async () => ({})),
  jobsForTask: vi.fn(async () => [
    { record: { seller: AGENT_EVM, buyer: BUYER_EVM, quote: "0xbooked" } },
  ]),
}));

const agentKey = generatePrivateKey();
const AGENT_EVM = privateKeyToAccount(agentKey).address;
const buyer = privateKeyToAccount(generatePrivateKey());
const BUYER_EVM = buyer.address;
const stranger = privateKeyToAccount(generatePrivateKey());
const REGISTRY = "0.0.11254658";

const flight = (date: string) => ({
  carrier: "Duffel Airways",
  flightNumber: "ZZ7426",
  origin: "BOM",
  destination: "GOI",
  departAt: `${date}T06:00:00`,
  arriveAt: `${date}T07:30:00`,
  stops: 0,
});
let orders: Record<string, ReturnType<typeof vi.fn>>;
beforeEach(() => {
  orders = {
    get: vi.fn(async () => ({
      orderId: "ord_1",
      bookingReference: "VRUDTM",
      total: "44.52",
      currency: "GBP",
      canChange: true,
      canCancel: true,
      cancelled: false,
      flights: [{ ...flight("2026-12-10"), sliceId: "sli_1" }],
    })),
    changeOffers: vi.fn(async () => [
      {
        offerId: "oco_1",
        expiresAt: "2026-12-01T00:00:00Z",
        changeTotal: "125.00",
        penalty: "25.00",
        newTotal: "144.48",
        currency: "GBP",
        flights: [flight("2026-12-11")],
      },
    ]),
    change: vi.fn(async () => ({
      orderId: "ord_1",
      bookingReference: "VRUDTM",
      currency: "GBP",
      paid: "125.00",
      flights: [{ ...flight("2026-12-11"), sliceId: "sli_2" }],
    })),
    cancelQuote: vi.fn(async () => ({ quoteId: "ore_1", refund: "34.52", currency: "GBP" })),
    cancel: vi.fn(async () => ({ cancelled: true })),
  };
});

function agent() {
  const store = new JsonStore<FlightRecord>();
  store.set("ord_1", {
    bookingId: "ord_1",
    task: "trip-1",
    quoteKey: "0xbooked",
    bookingReference: "VRUDTM",
  });
  const facilitator: Facilitator = {
    verify: async () => ({ isValid: true }),
    settle: async () => ({ success: true, transaction: "0.0.9@1.2", network: "hedera:testnet" }),
  };
  const s = createSpecialist(
    skyhop({} as never, { orders: orders as never, store, arkiv: {} as never, me: AGENT_EVM }),
    {
      identity: { key: agentKey, evm: AGENT_EVM, hederaAccount: "0.0.5005" },
      baseUrl: "http://skyhop",
      facilitator,
      usdcTokenId: "0.0.429274",
      executorId: REGISTRY,
      jobs: jobStore(),
    },
  );
  const call = async (who: typeof buyer, path: string, body: unknown = {}) => {
    const text = JSON.stringify(body);
    return s.app.request(`http://skyhop${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(await signedHeaders(who, "POST", path, text)),
      },
      body: text,
    });
  };
  const pay = (who: typeof buyer) =>
    createPayingFetch(
      {
        agent: privateKeyToAccount(generatePrivateKey()),
        mandateId: 2n,
        payer: "0.0.1",
        executor: REGISTRY,
        executorEvm: "0xc854860e659d5e70fd4e47146643abec6db634b6",
        chainId: 296,
        resolver: new MirrorResolver("https://mirror", (async () =>
          Response.json({ account: "0.0.5005", evm_address: AGENT_EVM })) as never),
      },
      (async (u: string, i?: RequestInit) => {
        const headers = new Headers(i?.headers);
        const body = String(i?.body ?? "");
        for (const [k, v] of Object.entries(await signedHeaders(who, "POST", "/work", body)))
          headers.set(k, v);
        return s.app.request(u, { ...i, headers });
      }) as typeof fetch,
    );
  return { call, pay, store };
}

describe("SkyHop booking management", () => {
  it("only the buyer can see or manage the booking", async () => {
    const a = agent();
    expect((await a.call(stranger, "/bookings/ord_1/view")).status).toBe(403);
    const res = await a.call(buyer, "/bookings/ord_1/view");
    expect(await res.json()).toMatchObject({
      booking: {
        bookingReference: "VRUDTM",
        canChange: true,
        flights: ["ZZ7426 BOM→GOI 2026-12-10 06:00"],
      },
    });
  });

  it("moving a flight: quoted as a flights.change job, paid through /work, done on Duffel", async () => {
    const a = agent();
    const res = await a.call(buyer, "/bookings/ord_1/change-options", { date: "2026-12-11" });
    const body = (await res.json()) as {
      options: { quoteKey: string; changeTotal: string }[];
      pay: { task: string; skill: string; input: unknown };
    };
    expect(body.options).toEqual([expect.objectContaining({ changeTotal: "125.00" })]);
    expect(body.pay).toEqual({
      task: "trip-1",
      skill: "flights.change",
      input: { orderId: "ord_1" },
    });
    const job = JSON.stringify({ ...body.pay, quoteKey: body.options[0]?.quoteKey });
    // someone else can't buy it, and pays nothing
    const theirs = await a.pay(stranger)("http://skyhop/work", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: job,
    });
    expect(theirs.response.status).toBe(422);
    expect(theirs.paid).toBeUndefined();
    const mine = await a.pay(buyer)("http://skyhop/work", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: job,
    });
    expect(mine.response.status).toBe(200);
    expect(mine.paid?.requirements.amount).toBe("20000"); // the change fee, not the booking fee
    expect(await mine.response.json()).toMatchObject({
      result: {
        bookingReference: "VRUDTM",
        flights: ["ZZ7426 BOM→GOI 2026-12-11 06:00"],
        paidForChange: "125.00 GBP",
      },
    });
    expect(orders.change).toHaveBeenCalledWith("oco_1");
  });

  it("cancelling needs a fresh cancel quote for this very booking", async () => {
    const a = agent();
    expect((await a.call(buyer, "/bookings/ord_1/cancel", { quoteId: "ore_other" })).status).toBe(
      409,
    );
    const q = (await (await a.call(buyer, "/bookings/ord_1/cancel-quote")).json()) as {
      quoteId: string;
    };
    expect(q).toMatchObject({ refund: "34.52", paid: "44.52" });
    expect((await a.call(buyer, "/bookings/ord_1/cancel", { quoteId: q.quoteId })).status).toBe(
      200,
    );
    expect(orders.cancel).toHaveBeenCalledWith("ore_1");
  });
});
