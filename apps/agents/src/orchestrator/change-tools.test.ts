import { openJob, recordReceipt, setJobStatus } from "@eth/arkiv";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TripRecord } from "../trips";
import { type ChangeDeps, type ChangeState, changeTools } from "./change-tools";

vi.mock("@eth/arkiv", () => ({
  openJob: vi.fn(async () => ({ entityKey: "0xnewjob" })),
  recordReceipt: vi.fn(async () => ({})),
  setJobStatus: vi.fn(async () => ({})),
}));

const STAY = "0x00000000000000000000000000000000000000aa";
const record = (): TripRecord => ({
  task: "trip-goi-1",
  trip: {} as never,
  savedAt: "2026-10-22T00:00:00Z",
  hires: [
    {
      skill: "hotels",
      agent: STAY,
      agentTitle: "StayWise",
      endpoint: "http://stay",
      jobKey: "0xjob1",
      quoteNote: "Park Inn",
      bookingId: "b1",
      status: "booked",
      result: {},
    },
  ],
  history: [],
});

// Free calls go through global fetch; paid ones through the mandate's paying fetch.
const replies: Record<string, unknown> = {
  "/view": { booking: { bookingId: "b1" }, cancelFeeNow: 0 },
  "/change-options": {
    options: [
      {
        quoteKey: "0xcheaper",
        total: 15000,
        currency: "INR",
        priceDifferencePercent: -16,
        checkin: "2026-11-13",
        checkout: "2026-11-15",
      },
      {
        quoteKey: "0xpricier",
        total: 28767,
        currency: "INR",
        priceDifferencePercent: 61,
        checkin: "2026-11-13",
        checkout: "2026-11-16",
      },
    ],
  },
  "/cancel": { result: { status: "CANCELLED", refund: 17815, fee: 0, currency: "INR" } },
};
const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
  const hit = Object.entries(replies).find(([k]) => url.endsWith(k));
  return Response.json(hit?.[1] ?? {});
});
const paid = {
  requirements: { payTo: "0.0.11116427", amount: "20000" },
  settlement: { transaction: "0.0.1@9" },
};

function setup(answer = "yes") {
  const state: ChangeState = {
    record: record(),
    approvals: new Set(),
    options: new Map(),
    failures: [],
  };
  const d = {
    signer: privateKeyToAccount(generatePrivateKey()),
    ask: vi.fn(async () => answer),
    save: vi.fn(),
    log: () => {},
    payingFetch: vi.fn(async () => ({
      response: Response.json({ result: { queued: false, bookingId: "b2", status: "CONFIRMED" } }),
      paid,
    })),
    buyerWriter: { account: { address: "0x0000000000000000000000000000000000000b0b" } },
    platformWriter: {},
    mandateId: 7n,
    payer: "0.0.11045937",
  } as unknown as ChangeDeps;
  return { state, d, t: changeTools(state, d) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
});

describe("change agent tools", () => {
  it("signs every request to the hotel agent as the buyer", async () => {
    const { t } = setup();
    await t.view.run({});
    const init = fetchMock.mock.calls[0]?.[1] as unknown as { headers: Record<string, string> };
    expect(init.headers["x-agent-signature"]).toMatch(/^0x/);
  });

  it("won't pay more than before without the traveller's yes", async () => {
    const { t, d } = setup();
    await t.options.run({ checkin: "2026-11-13", checkout: "2026-11-16", adults: 2 });
    await expect(t.confirm.run({ quoteKey: "0xpricier", reason: "extra night" })).rejects.toThrow(
      'ask_user about "pay_more" first',
    );
    expect(d.payingFetch).not.toHaveBeenCalled();
  });

  it("after a yes, rebooks and keeps the public record straight", async () => {
    const { t, d, state } = setup("yes");
    await t.options.run({ checkin: "2026-11-13", checkout: "2026-11-16", adults: 2 });
    await t.ask.run({ question: "Add a night for ₹28,767 (+61%)?", about: "pay_more" });
    const out = JSON.parse(
      (await t.confirm.run({ quoteKey: "0xpricier", reason: "extra night" })) as string,
    );
    expect(out).toMatchObject({ changed: true, newBookingId: "b2" });
    expect(setJobStatus).toHaveBeenCalledWith(d.buyerWriter, "0xjob1", "changed");
    expect(openJob).toHaveBeenCalledWith(
      d.buyerWriter,
      expect.objectContaining({ seller: STAY, quote: "0xpricier", status: "paid" }),
    );
    expect(recordReceipt).toHaveBeenCalledWith(
      d.platformWriter,
      expect.objectContaining({ job: "0xnewjob", amountUnits: 20_000n }),
    );
    expect(state.record.hires.map((h) => [h.bookingId, h.status])).toEqual([
      ["b1", "changed"],
      ["b2", "booked"],
    ]);
    expect(d.save).toHaveBeenCalled();
  });

  it("a 'no' is not an approval", async () => {
    const { t, state } = setup("no thanks");
    await t.ask.run({ question: "Pay ₹13,000 more?", about: "pay_more" });
    expect(state.approvals.has("pay_more")).toBe(false);
  });

  it("cheaper changes and free cancellations need no question", async () => {
    const { t, d } = setup();
    await t.options.run({ checkin: "2026-11-13", checkout: "2026-11-15", adults: 1 });
    await t.confirm.run({ quoteKey: "0xcheaper", reason: "one fewer guest" });
    expect(d.ask).not.toHaveBeenCalled();
    const { t: t2 } = setup();
    await t2.cancel.run({ reason: "plans changed" });
    expect(setJobStatus).toHaveBeenCalledWith(expect.anything(), "0xjob1", "cancelled");
  });

  it("won't cancel at a loss without the traveller's yes", async () => {
    replies["/view"] = { booking: { bookingId: "b1" }, cancelFeeNow: 17815 };
    const { t, state } = setup();
    await expect(t.cancel.run({ reason: "plans changed" })).rejects.toThrow(
      'ask_user about "lose_money"',
    );
    expect(state.record.hires[0]?.status).toBe("booked");
    replies["/view"] = { booking: { bookingId: "b1" }, cancelFeeNow: 0 };
  });
});
