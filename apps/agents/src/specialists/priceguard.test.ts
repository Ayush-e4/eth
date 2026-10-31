import { issueInvoice } from "@eth/arkiv";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signStatement } from "../auth";
import { JsonStore } from "../store";
import { priceGuard, type Watch } from "./priceguard";

vi.mock("@eth/arkiv", () => ({
  arkivReader: vi.fn(() => ({})),
  arkivWriter: vi.fn(() => ({})),
  issueInvoice: vi.fn(async () => ({ entityKey: `0x${"ee".repeat(32)}` })),
  findListings: vi.fn(async () => []),
  publishAgent: vi.fn(),
  NO_JOB_FEE: 0n,
}));

const stay = privateKeyToAccount(generatePrivateKey());
let store: JsonStore<Watch>;
let n = 0;

beforeEach(() => {
  n = 0;
  store = new JsonStore<Watch>();
  store.set("guard-b1", {
    task: "guard-b1",
    bookingId: "b1",
    buyer: "0x0000000000000000000000000000000000000b0b",
    stayEndpoint: "http://stay",
    stayAgent: stay.address,
    slip: { body: { minSavingInr: 100, minSavingPercent: 1 } } as never,
    status: "watching",
    invoices: [],
  });
  // StayWise, with a sandbox demo's simulated 2% drop on every look.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/reprice-options"))
        return Response.json({
          current: { paidTotal: 12711, comparedTotal: 12711, currency: "INR", cancelFeeNow: 0 },
          option: { optionKey: "k", total: 12462 },
          saving: 249,
          savingPercent: 2,
          simulated: true,
        });
      n += 1;
      return Response.json({
        proof: await signStatement(stay, "attestation", {
          kind: "reprice",
          oldBookingId: `b${n}`,
          newBookingId: `b${n + 1}`,
          checkin: "2026-12-08",
          checkout: "2026-12-10",
          paidTotal: 12711,
          comparedTotal: 12711,
          newTotal: 12462,
          currency: "INR",
          cancelFee: 0,
          refund: 12711,
          saving: 249,
          simulated: true,
          at: "2026-11-01T00:00:00Z",
        }),
      });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("PriceGuard's checks", () => {
  it("acts on a sandbox demo's simulated drop once, not on every check", async () => {
    const guard = priceGuard(
      {
        identity: { key: generatePrivateKey(), evm: "0x1", hederaAccount: "0.0.1" },
        baseUrl: "http://pg",
        facilitator: {} as never,
        usdcTokenId: "0.0.429274",
        executorId: "0.0.11254658",
      } as never,
      { store, inrPerUsdc: async () => 94 },
    );
    const log = () => {};
    await guard.checkOnce(log);
    await guard.checkOnce(log);
    await guard.checkOnce(log);
    const w = store.get("guard-b1");
    expect(issueInvoice).toHaveBeenCalledOnce();
    expect(w?.invoices).toHaveLength(1);
    expect(w?.bookingId).toBe("b2");
    expect(w?.checks?.map((c) => c.outcome)).toEqual([
      "rebooked: saved 249 INR",
      "a simulated drop is shown once; ignored",
      "a simulated drop is shown once; ignored",
    ]);
  });
});
