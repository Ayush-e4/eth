import { createPayingFetch, type Facilitator, MirrorResolver } from "@eth/x402";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jobStore } from "../specialists/jobs";
import { createSpecialist, type SpecialistContext } from "../specialists/server";
import { type Trip, TripSchema } from "../trip";
import { buy, type HireDeps } from "./hire";
import { HirePending } from "./job-client";
import type { QuoteRound } from "./quotes";

// The buyer (buy) against a real agent server in memory: what happens when paying goes wrong.

vi.mock("@eth/arkiv", () => ({
  arkivReader: vi.fn(() => ({})),
  arkivWriter: vi.fn(() => ({})),
  postQuote: vi.fn(async () => ({ entityKey: "0xq1", txHash: "0xt1" })),
  findListings: vi.fn(async () => []),
  publishAgent: vi.fn(async () => ({})),
  recordDelivery: vi.fn(async () => ({})),
  openJob: vi.fn(async () => ({ entityKey: "0xjob" })),
  recordReceipt: vi.fn(async () => ({})),
  rateAgent: vi.fn(async () => ({})),
}));

const REGISTRY = "0.0.11102395";
const agentKey = generatePrivateKey();
const identity = {
  key: agentKey,
  evm: privateKeyToAccount(agentKey).address,
  hederaAccount: "0.0.5005",
};
const trip: Trip = {
  origin: "BOM",
  destination: "GOI",
  destinationName: "Goa",
  departDate: "2026-11-06",
  returnDate: "2026-11-08",
  returnFlight: true,
  nonRefundableOk: false,
  hotelWishes: "",
  adults: 1,
  budgetInr: null,
  notes: "",
};
const round: QuoteRound = {
  skill: "flights",
  task: "trip-1",
  input: trip,
  options: [],
  bestReason: "",
  skipped: [],
};
const pick = {
  key: "0xq1" as const,
  agent: identity.evm,
  title: "TestHop — flights",
  note: "BOM→GOI",
  feeUnits: 50_000n,
  endpoint: "http://agent",
};

function market(ctx: Partial<SpecialistContext> & { settle: Facilitator["settle"] }) {
  const s = createSpecialist(
    {
      name: "TestHop",
      skill: "flights",
      input: TripSchema,
      title: "Cheapest flight",
      description: "test",
      priceUnits: 50_000n,
      quote: async () => ({
        note: "x",
        detail: { offerId: "off_1" },
        itemTotal: 1,
        itemCurrency: "INR",
      }),
      work: async (_b, d) => ({ booked: d.offerId }),
    },
    {
      identity,
      baseUrl: "http://agent",
      facilitator: { verify: async () => ({ isValid: true }), settle: ctx.settle },
      usdcTokenId: "0.0.429274",
      executorId: REGISTRY,
      jobs: jobStore(),
      ...ctx,
    },
  );
  const appFetch = ((u: string, i?: RequestInit) => s.app.request(u, i)) as typeof fetch;
  vi.stubGlobal("fetch", appFetch); // the buyer reads /jobs with plain fetch
  const d = {
    buyerWriter: { account: privateKeyToAccount(generatePrivateKey()) },
    platformWriter: {},
    mandateId: 1n,
    payer: "0.0.1",
    log: () => {},
    jobWaitMs: 2_000,
    payingFetch: createPayingFetch(
      {
        agent: privateKeyToAccount(generatePrivateKey()),
        mandateId: 1n,
        payer: "0.0.1",
        executor: REGISTRY,
        executorEvm: "0x2f30e8F1804Fe163C76918db493a441D44394D5d",
        chainId: 296,
        resolver: new MirrorResolver("https://mirror", (async () =>
          Response.json({ account: identity.hederaAccount, evm_address: identity.evm })) as never),
        maxAmount: 100_000n,
      },
      appFetch,
    ),
  } as unknown as HireDeps;
  return { s, d };
}

const broken = async (): Promise<never> => {
  throw new Error("socket hang up");
};

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("buy() when paying goes wrong", () => {
  it("the agent's payment call broke, the chain says paid: buy reads the job back and records it", async () => {
    const { s, d } = market({
      settle: broken,
      paymentState: async () => ({ state: "paid", transaction: "0.0.9@7.7?scheduled" }),
    });
    await s.app.request("http://agent/quote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "trip-1", skill: "flights", input: trip }),
    });
    const hire = await buy(round, pick as never, "flights", d, "cheapest");
    expect(hire).toMatchObject({
      result: { booked: "off_1" },
      hederaTx: "0.0.9@7.7?scheduled",
      jobKey: "0xjob",
    });
  });

  it("the agent never finishes in time: HirePending says where to read it later", async () => {
    const { s, d } = market({ settle: async () => new Promise<never>(() => {}) });
    await s.app.request("http://agent/quote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "trip-1", skill: "flights", input: trip }),
    });
    const payingFetch = d.payingFetch;
    // the /work call itself hangs (as when settling waits out an undo window), then breaks
    d.payingFetch = (async (u: string, i?: RequestInit) => {
      void payingFetch(u, i);
      await new Promise((r) => setTimeout(r, 50));
      throw new Error("socket hang up");
    }) as HireDeps["payingFetch"];
    const err = await buy(round, pick as never, "flights", d, "cheapest").catch((e) => e);
    expect(err).toBeInstanceOf(HirePending);
    expect(err).toMatchObject({ endpoint: "http://agent", quoteKey: "0xq1" });
  });

  it("the call failed before any job existed: the original error, right away", async () => {
    const { d } = market({ settle: broken });
    d.payingFetch = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as HireDeps["payingFetch"];
    await expect(buy(round, pick as never, "flights", d, "cheapest")).rejects.toThrow(
      "ECONNREFUSED",
    );
  });
});
