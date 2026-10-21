import { Hono } from "hono";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signedHeaders, signStatement, verifyStatement } from "../auth";
import { JsonStore } from "../store";
import type { SpecialistKit } from "./server";
import type { BookingRecord } from "./staywise-manage";
import { repriceRoutes } from "./staywise-reprice";

vi.mock("@eth/arkiv", () => ({ jobsForTask: vi.fn(async () => []), postQuote: vi.fn() }));

const stayKey = generatePrivateKey();
const stay = privateKeyToAccount(stayKey);
const owner = privateKeyToAccount(generatePrivateKey());
const guard = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());
const slipBody = (over = {}) => ({
  bookingId: "b1",
  agent: stay.address,
  delegate: guard.address,
  minSavingInr: 500,
  minSavingPercent: 5,
  until: "2026-11-13",
  issuedAt: 1,
  ...over,
});

function setup(newTotal = 15000, simulateDropPercent?: number) {
  const store = new JsonStore<BookingRecord>();
  store.set("b1", {
    bookingId: "b1",
    task: "t1",
    quoteKey: "0xq",
    owner: owner.address,
    hotelId: "h1",
    adults: 2,
  });
  const order: string[] = [];
  const bookings = {
    get: vi.fn(async (id: string) => ({
      bookingId: id,
      status: "CONFIRMED",
      hotelName: "Park Inn",
      checkin: "2026-11-13",
      checkout: "2026-11-15",
      total: 17815,
      currency: "INR",
      refundable: true,
      cancelFees: [{ after: "2026-10-29 10:00:00", amount: 17815 }],
    })),
    cancel: vi.fn(async (id: string) => {
      order.push(`cancel ${id}`);
      return { status: "CANCELLED", fee: 0, refund: 17815, currency: "INR" };
    }),
  };
  const lite = {
    searchHotels: vi.fn(async () => [
      {
        offerId: "o1",
        hotelId: "h1",
        hotelName: "Park Inn",
        roomName: "Standard",
        total: newTotal,
        currency: "INR",
      },
    ]),
    prebook: vi.fn(async () => ({
      prebookId: "pb1",
      total: newTotal,
      currency: "INR",
      priceChangedPercent: 0,
      refundable: true,
    })),
    book: vi.fn(async () => {
      order.push("book new");
      return { bookingId: "b2", status: "CONFIRMED" };
    }),
  };
  const kit = {
    ctx: { identity: { key: stayKey, evm: stay.address, hederaAccount: "0.0.5" } },
  } as unknown as SpecialistKit;
  const app = new Hono();
  repriceRoutes({
    bookings: bookings as never,
    lite: lite as never,
    store,
    arkiv: {} as never,
    simulateDropPercent,
    now: () => new Date("2026-10-22T00:00:00Z"),
  })(app, kit);
  const call = async (path: string, payload: unknown, who = guard) => {
    const body = JSON.stringify(payload);
    return app.request(`http://stay${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(await signedHeaders(who, "POST", path, body)),
      },
      body,
    });
  };
  return { store, bookings, lite, call, order };
}

beforeEach(() => vi.clearAllMocks());

describe("StayWise repricing for a watcher", () => {
  it("accepts only a permission slip signed by the booking's owner, for the watcher presenting it", async () => {
    const { call, store } = setup();
    const forged = await signStatement(stranger, "reprice-delegation", slipBody());
    expect((await call("/bookings/b1/delegate", { delegation: forged })).status).toBe(403);
    const real = await signStatement(owner, "reprice-delegation", slipBody());
    expect((await call("/bookings/b1/delegate", { delegation: real }, stranger)).status).toBe(403);
    expect((await call("/bookings/b1/delegate", { delegation: real })).status).toBe(200);
    expect(store.get("b1")?.delegations).toHaveLength(1);
    expect((await call("/bookings/b1/reprice-options", {}, stranger)).status).toBe(403);
  });

  it("books the cheaper rate first, then cancels the old one, and signs what happened", async () => {
    const { call, order, store } = setup(15000);
    await call("/bookings/b1/delegate", {
      delegation: await signStatement(owner, "reprice-delegation", slipBody()),
    });
    const opts = (await (await call("/bookings/b1/reprice-options", {})).json()) as {
      option: { optionKey: string };
      saving: number;
    };
    expect(opts.saving).toBe(2815);
    const res = await call("/bookings/b1/reprice", { optionKey: opts.option.optionKey });
    const { proof } = (await res.json()) as {
      proof: { signer: string; body: { saving: number; newBookingId: string; simulated: boolean } };
    };
    expect(order).toEqual(["book new", "cancel b1"]);
    expect(proof.signer).toBe(stay.address);
    expect(await verifyStatement("attestation", proof as never)).toBe(true);
    expect(proof.body).toMatchObject({ saving: 2815, newBookingId: "b2", simulated: false });
    expect(store.get("b1")?.replacedBy).toBe("b2");
    expect(store.get("b2")?.delegations).toHaveLength(1); // the watch carries over
  });

  it("enforces the owner's limits, not the watcher's", async () => {
    const { call, lite } = setup(17500); // saves ₹315 (1.8%)
    await call("/bookings/b1/delegate", {
      delegation: await signStatement(owner, "reprice-delegation", slipBody()),
    });
    const opts = (await (await call("/bookings/b1/reprice-options", {})).json()) as {
      option: { optionKey: string };
    };
    const res = await call("/bookings/b1/reprice", { optionKey: opts.option.optionKey });
    expect(res.status).toBe(409);
    expect(lite.book).not.toHaveBeenCalled();
  });

  it("never leaves two rooms: if the old one can't be cancelled, the new one is", async () => {
    const { call, bookings } = setup(15000);
    bookings.cancel.mockRejectedValueOnce(new Error("supplier down"));
    await call("/bookings/b1/delegate", {
      delegation: await signStatement(owner, "reprice-delegation", slipBody()),
    });
    const opts = (await (await call("/bookings/b1/reprice-options", {})).json()) as {
      option: { optionKey: string };
    };
    const res = await call("/bookings/b1/reprice", { optionKey: opts.option.optionKey });
    expect(res.status).toBe(502);
    expect(bookings.cancel).toHaveBeenLastCalledWith("b2");
  });

  it("labels a simulated drop in the signed proof", async () => {
    const { call } = setup(17815, 15); // same price, but pretend it cost 15% more
    await call("/bookings/b1/delegate", {
      delegation: await signStatement(owner, "reprice-delegation", slipBody()),
    });
    const opts = (await (await call("/bookings/b1/reprice-options", {})).json()) as {
      option: { optionKey: string };
      simulated: boolean;
    };
    expect(opts.simulated).toBe(true);
    const { proof } = (await (
      await call("/bookings/b1/reprice", { optionKey: opts.option.optionKey })
    ).json()) as { proof: { body: { simulated: boolean; paidTotal: number } } };
    expect(proof.body).toMatchObject({ simulated: true, paidTotal: 17815 });
  });
});
