import { findListings, postQuote, publishAgent } from "@eth/arkiv";
import { createPayingFetch, type Facilitator, MirrorResolver } from "@eth/x402";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Trip } from "../trip";
import { createSpecialist, type SpecialistDef } from "./server";

vi.mock("@eth/arkiv", () => ({
  arkivReader: vi.fn(() => ({})),
  arkivWriter: vi.fn(() => ({})),
  postQuote: vi.fn(async () => ({ entityKey: "0xq1", txHash: "0xt1" })),
  findListings: vi.fn(async () => []),
  publishAgent: vi.fn(async () => ({ txHash: "0xpub" })),
}));

const REGISTRY = "0.0.11102395";
const REGISTRY_EVM = "0x2f30e8F1804Fe163C76918db493a441D44394D5d";
const key = generatePrivateKey();
const identity = { key, evm: privateKeyToAccount(key).address, hederaAccount: "0.0.5005" };
const trip: Trip = {
  origin: "BOM",
  destination: "GOI",
  destinationName: "Goa",
  departDate: "2026-11-06",
  returnDate: "2026-11-08",
  returnFlight: true,
  nonRefundableOk: false,
  hotelWishes: "",
  adults: 2,
  budgetInr: 40000,
  notes: "",
};

const facilitator: Facilitator = {
  verify: async () => ({ isValid: true, payer: "0.0.1" }),
  settle: async () => ({
    success: true,
    transaction: "0.0.9@1.2",
    network: "hedera:testnet",
    payer: "0.0.1",
  }),
};

function setup(
  opts: {
    failWork?: boolean;
    refund?: (to: string, units: bigint, memo: string) => Promise<string>;
  } = {},
) {
  const def: SpecialistDef<{ offerId: string }, { booked: string }> = {
    name: "TestHop",
    skill: "flights",
    title: "Cheapest flight",
    description: "test",
    priceUnits: 50_000n,
    quote: vi.fn(async () => ({
      note: "IndiGo BOM→GOI",
      detail: { offerId: "off_1" },
      itemTotal: 5400,
      itemCurrency: "INR",
    })),
    work: vi.fn(async (_body, d) => {
      if (opts.failWork) throw new Error("supplier said no");
      return { booked: d.offerId };
    }),
  };
  const s = createSpecialist(def, {
    identity,
    baseUrl: "http://agent",
    facilitator,
    usdcTokenId: "0.0.429274",
    executorId: REGISTRY,
    refund: opts.refund,
  });
  const appFetch = ((url: string, init?: RequestInit) => s.app.request(url, init)) as typeof fetch;
  const mirror = (async () =>
    Response.json({ account: identity.hederaAccount, evm_address: identity.evm })) as never;
  const pay = createPayingFetch(
    {
      agent: privateKeyToAccount(generatePrivateKey()),
      mandateId: 1n,
      payer: "0.0.1",
      executor: REGISTRY,
      executorEvm: REGISTRY_EVM,
      chainId: 296,
      resolver: new MirrorResolver("https://mirror", mirror),
      maxAmount: 100_000n,
    },
    appFetch,
  );
  const post = (path: string, body: unknown) =>
    s.app.request(`http://agent${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const work = (quoteKey: string) =>
    pay("http://agent/work", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "trip-goi-1", trip, quoteKey }),
    });
  return { s, def, post, work };
}

beforeEach(() => vi.clearAllMocks());

describe("specialist agent server", () => {
  it("quotes for free and posts the quote on Arkiv with a 3-minute expiry", async () => {
    const { post } = setup();
    const res = await post("/quote", { task: "trip-goi-1", trip });
    expect(await res.json()).toEqual({
      quoteKey: "0xq1",
      priceUnits: "50000",
      note: "IndiGo BOM→GOI",
      itemTotal: 5400,
      itemCurrency: "INR",
    });
    expect(postQuote).toHaveBeenCalledWith(
      {},
      {
        agent: identity.evm,
        task: "trip-goi-1",
        skill: "flights",
        priceUnits: 50_000n,
        note: "IndiGo BOM→GOI",
        itemTotal: 5400,
        itemCurrency: "INR",
      },
      180,
    );
  });

  it("asks for the agent fee (402) to its own Hedera account before doing work", async () => {
    const { post } = setup();
    await post("/quote", { task: "trip-goi-1", trip });
    const res = await post("/work", { task: "trip-goi-1", trip, quoteKey: "0xq1" });
    expect(res.status).toBe(402);
    const body = (await res.json()) as { accepts: Record<string, unknown>[] };
    expect(body.accepts[0]).toMatchObject({ amount: "50000", payTo: "0.0.5005" });
  });

  it("refuses unknown quotes before any payment is taken", async () => {
    const { post } = setup();
    const res = await post("/work", { task: "trip-goi-1", trip, quoteKey: "0xnope" });
    expect(res.status).toBe(409);
    expect(res.headers.get("PAYMENT-REQUIRED")).toBeNull();
  });

  it("does exactly the quoted job once it is paid, and only once", async () => {
    const { post, work, def } = setup();
    await post("/quote", { task: "trip-goi-1", trip });
    const first = await work("0xq1");
    expect(first.response.status).toBe(200);
    expect(await first.response.json()).toEqual({ agent: "TestHop", result: { booked: "off_1" } });
    expect(first.paid?.settlement.transaction).toBe("0.0.9@1.2");
    expect(def.work).toHaveBeenCalledTimes(1);

    const again = await work("0xq1");
    expect(again.response.status).toBe(409);
    expect(again.paid).toBeUndefined(); // refused before any payment
  });

  it("refunds the fee to the payer when it was paid but couldn't deliver", async () => {
    const refund = vi.fn(async () => "0.0.5005@9.9");
    const { post, work } = setup({ failWork: true, refund });
    await post("/quote", { task: "trip-goi-1", trip });
    const res = await work("0xq1");
    expect(res.response.status).toBe(502);
    expect(await res.response.json()).toEqual({
      error: "work_failed",
      detail: "supplier said no",
      refund: { transaction: "0.0.5005@9.9" },
    });
    expect(refund).toHaveBeenCalledWith("0.0.1", 50_000n, "refund trip-goi-1");
  });

  it("publishes its profile + listing once", async () => {
    const { s } = setup();
    await s.publish();
    expect(publishAgent).toHaveBeenCalledTimes(1);
    vi.mocked(findListings).mockResolvedValueOnce([{ record: { agent: identity.evm } }] as never);
    expect(await s.publish()).toEqual({ alreadyListed: true });
    expect(publishAgent).toHaveBeenCalledTimes(1);
  });
});
