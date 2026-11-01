import { findListings, liveQuotes, openJob, rateAgent, recordReceipt } from "@eth/arkiv";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Trip } from "../trip";
import { type HireDeps, hire } from "./hire";
import { collectQuotes } from "./quotes";

vi.mock("@eth/arkiv", () => ({
  findListings: vi.fn(),
  liveQuotes: vi.fn(),
  openJob: vi.fn(async () => ({ entityKey: "0xjob", txHash: "0xt" })),
  recordReceipt: vi.fn(async () => ({ entityKey: "0xrcpt", txHash: "0xt" })),
  rateAgent: vi.fn(async () => ({ entityKey: "0xrate", txHash: "0xt" })),
}));

const A = "0x00000000000000000000000000000000000000aa";
const B = "0x00000000000000000000000000000000000000bb";
const C = "0x00000000000000000000000000000000000000cc"; // not in the mandate
const buyerAccount = privateKeyToAccount(generatePrivateKey()); // signs /work
const BUYER = buyerAccount.address;
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
  budgetInr: null,
  notes: "",
};

const listing = (agent: string) => ({
  key: `0xlisting${agent.slice(-2)}`,
  record: {
    agent,
    skill: "flights",
    title: `agent ${agent.slice(-2)}`,
    endpoint: `http://${agent}`,
  },
});
const quote = (agent: string, priceUnits: bigint, itemTotal?: number, itemCurrency?: string) => ({
  key: `0xquote${agent.slice(-2)}`,
  record: {
    agent,
    task: "t1",
    skill: "flights",
    priceUnits,
    note: `quote ${agent.slice(-2)}`,
    itemTotal,
    itemCurrency,
  },
  secondsLeft: 170,
});

function deps(over: Partial<HireDeps> = {}): HireDeps {
  return {
    arkiv: {} as never,
    buyerWriter: { account: buyerAccount } as never,
    platformWriter: {} as never,
    payingFetch: vi.fn(async () => ({
      response: Response.json({ result: { orderId: "ord_1" } }),
      paid: {
        settlement: { transaction: "0.0.1@1.1" },
        requirements: { payTo: "0.0.5005" },
      },
    })) as never,
    evm: {
      readContract: vi.fn(
        async ({ functionName, args }: { functionName: string; args: [bigint, string] }) =>
          functionName === "getMandate" ? { restrictPayees: true } : args[1] !== C,
      ),
    } as never,
    registry: "0x2f30e8F1804Fe163C76918db493a441D44394D5d",
    mandateId: 3n,
    payer: "0.0.1",
    inrRates: { INR: 1, GBP: 126.61, USD: 94.47, USDC: 94.47 },
    log: () => {},
    ...over,
  };
}

const quoteFetch = vi.fn(async (_url: string) => new Response("{}"));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", quoteFetch);
  vi.mocked(findListings).mockResolvedValue([listing(A), listing(B), listing(C)] as never);
  // C is cheapest of all but not allowed by the mandate. B has the lower agent fee but a
  // pricier ticket (£60 ≈ ₹7,597); A costs more in fees but less in total (₹6,000 + fee).
  vi.mocked(liveQuotes).mockResolvedValue([
    quote(C, 10_000n, 1000, "INR"),
    quote(B, 30_000n, 60, "GBP"),
    quote(A, 50_000n, 6000, "INR"),
  ] as never);
});

describe("hire", () => {
  it("weighs the track record: a cheaper agent that keeps refunding loses to a reliable one", async () => {
    const records: Record<string, { delivered: number; failed: number }> = {
      [A]: { delivered: 1, failed: 9 }, // cheapest total, but it rarely delivers
      [B]: { delivered: 10, failed: 0 },
    };
    const d = deps({ trackRecord: async (a: string) => records[a] ?? null } as never);
    const h = await hire("flights", "t1", trip, d);
    expect(h.agent).toBe(B);
    expect(h.choice).toContain("delivered 10 of 10 paid jobs");
    expect(h.choice).toContain("has delivered only 1 of 10 paid jobs");
  });

  it("a limit for any agent (an app connection's) asks every listed agent", async () => {
    const d = deps({
      evm: {
        readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
          functionName === "getMandate" ? { restrictPayees: false } : false,
        ),
      } as never,
    });
    await hire("flights", "t1", trip, d);
    expect(quoteFetch.mock.calls.map((c) => c[0])).toEqual([
      `http://${A}/quote`,
      `http://${B}/quote`,
      `http://${C}/quote`,
    ]);
  });

  it("asks only mandate-allowed agents, buys the lowest TOTAL cost, records it on Arkiv", async () => {
    const d = deps();
    const h = await hire("flights", "t1", trip, d);

    expect(quoteFetch.mock.calls.map((c) => c[0])).toEqual([
      `http://${A}/quote`,
      `http://${B}/quote`,
    ]);
    expect(h).toMatchObject({ agent: A, feeUnits: 50_000n, itemTotal: 6000, itemCurrency: "INR" });
    expect(h.choice).toBe(
      "lowest total of 2 comparable quote(s): ₹6,005 total = item ₹6,000 + agent fee ₹5, no track record yet",
    );
    expect(h.rejected).toEqual([
      expect.stringContaining("not an allowed payee"),
      "agent bb: ₹7,599 total = item ₹7,597 (60 GBP at ECB rate) + agent fee ₹3",
    ]);
    expect(d.payingFetch).toHaveBeenCalledWith(`http://${A}/work`, expect.anything());
    const sent = JSON.parse(vi.mocked(d.payingFetch).mock.calls[0]?.[1]?.body as string);
    expect(sent.quoteKey).toBe("0xquoteaa");

    expect(openJob).toHaveBeenCalledWith(
      d.buyerWriter,
      expect.objectContaining({ buyer: BUYER, seller: A, status: "paid", mandateId: 3n }),
    );
    expect(recordReceipt).toHaveBeenCalledWith(
      d.platformWriter,
      expect.objectContaining({ job: "0xjob", payTo: "0.0.5005", amountUnits: 50_000n }),
    );
    expect(rateAgent).toHaveBeenCalledWith(
      d.buyerWriter,
      expect.objectContaining({ agent: A, job: "0xjob", score: 5 }),
    );
  });

  it("in a chat with one agent, asks only that agent", async () => {
    const round = await collectQuotes("flights", "t1", trip, { ...deps(), only: B.toUpperCase() });
    expect(quoteFetch.mock.calls.map((c) => c[0])).toEqual([`http://${B}/quote`]);
    expect(round.options.map((o) => o.agent)).toEqual([B]);
  });

  it("falls back to the cheapest fee when no quote has a comparable price", async () => {
    vi.mocked(liveQuotes).mockResolvedValue([quote(B, 30_000n), quote(A, 50_000n)] as never);
    const h = await hire("flights", "t1", trip, deps());
    expect(h.agent).toBe(B);
    expect(h.choice).toContain("cheapest agent fee");
    expect(h.rejected).toContain("agent aa: no comparable price");
  });

  it("an agent that fails to quote is skipped, not fatal", async () => {
    quoteFetch.mockImplementation(async (url: string) =>
      url.includes(B) ? new Response("down", { status: 503 }) : new Response("{}"),
    );
    vi.mocked(liveQuotes).mockResolvedValue([quote(A, 50_000n)] as never);
    const h = await hire("flights", "t1", trip, deps());
    expect(h.agent).toBe(A);
    expect(h.rejected).toContainEqual(expect.stringContaining("no quote (Error: HTTP 503 down)"));
  });

  it("refuses when no listed agent is an allowed payee", async () => {
    vi.mocked(findListings).mockResolvedValue([listing(C)] as never);
    const d = deps();
    await expect(hire("flights", "t1", trip, d)).rejects.toThrow("allowed payee in mandate #3");
    expect(d.payingFetch).not.toHaveBeenCalled();
  });

  it("reports the refund when a paid agent fails, and survives non-JSON replies", async () => {
    const refunded = vi.fn(async () => ({
      response: Response.json(
        { error: "work_failed", detail: "supplier said no", refund: { transaction: "0.0.9@1.1" } },
        { status: 502 },
      ),
      paid: { settlement: { transaction: "0.0.1@1.1" }, requirements: { payTo: "0.0.5005" } },
    }));
    await expect(
      hire("flights", "t1", trip, deps({ payingFetch: refunded } as never)),
    ).rejects.toThrow("HTTP 502 work_failed supplier said no — fee refunded: 0.0.9@1.1");
    const html = vi.fn(async () => ({
      response: new Response("Internal Server Error", { status: 500 }),
      paid: { settlement: { transaction: "0.0.1@1.1" }, requirements: { payTo: "0.0.5005" } },
    }));
    await expect(hire("flights", "t1", trip, deps({ payingFetch: html } as never))).rejects.toThrow(
      "HTTP 500 non_json_reply Internal Server Error",
    );
    expect(openJob).not.toHaveBeenCalled();
  });

  it("records nothing on Arkiv when the payment is refused", async () => {
    const payingFetch = vi.fn(async () => ({
      response: Response.json(
        { error: "mandate_inactive", detail: "MandateInactive" },
        { status: 402 },
      ),
    }));
    await expect(hire("flights", "t1", trip, deps({ payingFetch } as never))).rejects.toThrow(
      "HTTP 402 mandate_inactive MandateInactive",
    );
    expect(openJob).not.toHaveBeenCalled();
    expect(recordReceipt).not.toHaveBeenCalled();
  });

  it("never loses a paid hire when Arkiv refuses a record afterwards", async () => {
    vi.mocked(rateAgent).mockRejectedValueOnce(
      new Error("expiry beyond the chain's maximum lifetime"),
    );
    const log = vi.fn();
    const h = await hire("flights", "t1", trip, deps({ log }));
    expect(h).toMatchObject({ agent: A, hederaTx: "0.0.1@1.1", jobKey: "0xjob" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("couldn't record the rating"));

    vi.mocked(openJob).mockRejectedValueOnce(new Error("Arkiv down"));
    const noJob = await hire("flights", "t1", trip, deps());
    expect(noJob).toMatchObject({ hederaTx: "0.0.1@1.1", jobKey: "0x" }); // paid, still returned
  });
});
