import { jobsForTask, postQuote } from "@eth/arkiv";
import { createPayingFetch, type Facilitator, MirrorResolver, paywall } from "@eth/x402";
import { Hono } from "hono";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signedHeaders } from "../auth";
import { JsonStore } from "../store";
import type { SpecialistKit } from "./server";
import { type BookingRecord, manageRoutes } from "./staywise-manage";

vi.mock("@eth/arkiv", () => ({ jobsForTask: vi.fn(), postQuote: vi.fn() }));

const REGISTRY = "0.0.11102395";
const stayKey = generatePrivateKey();
const stay = { key: stayKey, evm: privateKeyToAccount(stayKey).address, hederaAccount: "0.0.5005" };
const buyer = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());
const facilitator: Facilitator = {
  verify: async () => ({ isValid: true, payer: "0.0.1" }),
  settle: async () => ({
    success: true,
    transaction: "0.0.9@1.2",
    network: "hedera:testnet",
    payer: "0.0.1",
  }),
};
const managed = (bookingId: string) => ({
  bookingId,
  status: "CONFIRMED",
  hotelName: "Park Inn",
  checkin: "2026-11-13",
  checkout: "2026-11-15",
  total: 17815.68,
  currency: "INR",
  refundable: true,
  holder: { firstName: "Asha", lastName: "Traveller", email: "a@example.com" },
  cancelFees: [{ after: "2026-10-29 10:00:00", amount: 17815.68 }],
});

function setup() {
  const store = new JsonStore<BookingRecord>();
  store.set("b1", { bookingId: "b1", task: "trip-goi-1", quoteKey: "0xq1" });
  const bookings = {
    get: vi.fn(async (id: string) => managed(id)),
    changeOptions: vi.fn(async () => [
      {
        prebookId: "pb_a",
        total: 28767.44,
        currency: "INR",
        priceDifferencePercent: 61,
        checkin: "2026-11-13",
        checkout: "2026-11-16",
      },
    ]),
    rebook: vi.fn(async () => ({ queued: false as const, bookingId: "b2", status: "CONFIRMED" })),
    amendHolder: vi.fn(async () => ({ amendmentId: 3659, status: "PENDING" })),
    cancel: vi.fn(async () => ({ status: "CANCELLED", fee: 0, refund: 17815.68, currency: "INR" })),
  };
  const kit: SpecialistKit = {
    writer: {} as never,
    ctx: {
      identity: stay,
      baseUrl: "http://stay",
      facilitator,
      usdcTokenId: "0.0.429274",
      executorId: REGISTRY,
    },
    feeWall: (units, description) =>
      paywall({
        network: "hedera:testnet",
        asset: "0.0.429274",
        amount: units.toString(),
        payTo: stay.hederaAccount,
        executors: [REGISTRY],
        facilitator,
        description,
      }),
    refundPaid: vi.fn(async () => ({ transaction: "0.0.5005@9.9" })),
  };
  const app = new Hono();
  manageRoutes({
    bookings: bookings as never,
    store,
    arkiv: {} as never,
    now: () => new Date("2026-10-22T00:00:00Z"),
  })(app, kit);
  const appFetch = ((url: string, init?: RequestInit) => app.request(url, init)) as typeof fetch;
  const mirror = (async () =>
    Response.json({ account: stay.hederaAccount, evm_address: stay.evm })) as never;
  const pay = createPayingFetch(
    {
      agent: buyer,
      mandateId: 1n,
      payer: "0.0.1",
      executor: REGISTRY,
      executorEvm: "0x2f30e8F1804Fe163C76918db493a441D44394D5d",
      chainId: 296,
      resolver: new MirrorResolver("https://mirror", mirror),
      maxAmount: 100_000n,
    },
    appFetch,
  );
  const call = async (path: string, payload: unknown, who = buyer, paid = false) => {
    const body = JSON.stringify(payload);
    const headers = {
      "content-type": "application/json",
      ...(await signedHeaders(who, "POST", path, body)),
    };
    if (paid) return pay(`http://stay${path}`, { method: "POST", headers, body });
    return { response: await app.request(`http://stay${path}`, { method: "POST", headers, body }) };
  };
  return { app, store, bookings, kit, call };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(jobsForTask).mockResolvedValue([
    { record: { seller: stay.evm, quote: "0xq1", buyer: buyer.address } },
  ] as never);
  vi.mocked(postQuote).mockResolvedValue({ entityKey: "0xopt1", txHash: "0xt" } as never);
});

describe("StayWise booking management", () => {
  it("lets only the buyer on the Arkiv job see the booking", async () => {
    const { call, store } = setup();
    const ok = await call("/bookings/b1/view", {});
    expect(ok.response.status).toBe(200);
    expect(await ok.response.json()).toMatchObject({
      booking: { bookingId: "b1" },
      cancelFeeNow: 0,
    });
    expect(store.get("b1")?.owner).toBe(buyer.address); // cached after the Arkiv check
    expect((await call("/bookings/b1/view", {}, stranger)).response.status).toBe(403);
    expect((await call("/bookings/nope/view", {})).response.status).toBe(404);
  });

  it("rejects unsigned requests", async () => {
    const { app } = setup();
    const res = await app.request("http://stay/bookings/b1/cancel", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  });

  it("offers locked change options and posts them as quotes on Arkiv", async () => {
    const { call } = setup();
    const res = await call("/bookings/b1/change-options", {
      checkin: "2026-11-13",
      checkout: "2026-11-16",
      adults: 2,
    });
    const out = (await res.response.json()) as {
      options: { quoteKey: string; priceDifferencePercent: number }[];
    };
    expect(out.options).toEqual([
      expect.objectContaining({ quoteKey: "0xopt1", priceDifferencePercent: 61 }),
    ]);
    expect(postQuote).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ skill: "hotels.change", priceUnits: 20_000n, itemTotal: 28767.44 }),
      180,
    );
  });

  it("refuses an unknown option before any payment, then changes a real one for 0.02 USDC", async () => {
    const { call, bookings, store } = setup();
    const bad = await call("/bookings/b1/change", { quoteKey: "0xmadeup" });
    expect(bad.response.status).toBe(409);
    expect(bad.response.headers.get("PAYMENT-REQUIRED")).toBeNull();

    await call("/bookings/b1/change-options", {
      checkin: "2026-11-13",
      checkout: "2026-11-16",
      adults: 2,
    });
    const done = await call("/bookings/b1/change", { quoteKey: "0xopt1" }, buyer, true);
    expect(done.response.status).toBe(200);
    expect(done.paid?.requirements.amount).toBe("20000");
    expect(bookings.rebook).toHaveBeenCalledWith("pb_a", "b1", {
      firstName: "Asha",
      lastName: "Traveller",
      email: "a@example.com",
    });
    expect(store.get("b2")).toMatchObject({ quoteKey: "0xopt1", owner: buyer.address });
    expect(store.get("b1")?.replacedBy).toBe("b2");
    expect((await call("/bookings/b1/view", {})).response.status).toBe(409); // old booking is gone
  });

  it("changes the lead guest for 0.01 USDC and cancels for free", async () => {
    const { call, bookings } = setup();
    const guest = await call(
      "/bookings/b1/guest",
      { firstName: "Rohan", lastName: "Traveller", email: "r@example.com" },
      buyer,
      true,
    );
    expect(guest.paid?.requirements.amount).toBe("10000");
    expect(bookings.amendHolder).toHaveBeenCalledWith("b1", {
      firstName: "Rohan",
      lastName: "Traveller",
      email: "r@example.com",
    });
    const cancel = await call("/bookings/b1/cancel", {});
    expect(await cancel.response.json()).toMatchObject({
      result: { status: "CANCELLED", refund: 17815.68 },
    });
    expect(bookings.cancel).toHaveBeenCalledWith("b1");
  });

  it("refunds the fee when a paid change fails", async () => {
    const { call, bookings, kit } = setup();
    bookings.rebook.mockRejectedValueOnce(new Error("no availability"));
    await call("/bookings/b1/change-options", {
      checkin: "2026-11-13",
      checkout: "2026-11-16",
      adults: 2,
    });
    const res = await call("/bookings/b1/change", { quoteKey: "0xopt1" }, buyer, true);
    expect(res.response.status).toBe(502);
    expect(await res.response.json()).toMatchObject({
      error: "change_failed",
      refund: { transaction: "0.0.5005@9.9" },
    });
    expect(kit.refundPaid).toHaveBeenCalled();
  });
});
