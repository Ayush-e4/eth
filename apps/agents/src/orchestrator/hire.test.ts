import { findListings, liveQuotes, openJob, rateAgent, recordReceipt } from "@eth/arkiv";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Trip } from "../trip";
import { type HireDeps, hire } from "./hire";

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
const BUYER = "0x0000000000000000000000000000000000000b0b";
const trip: Trip = {
  origin: "BOM",
  destination: "GOI",
  destinationName: "Goa",
  departDate: "2026-11-06",
  returnDate: "2026-11-08",
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
const quote = (agent: string, priceUnits: bigint) => ({
  key: `0xquote${agent.slice(-2)}`,
  record: { agent, task: "t1", skill: "flights", priceUnits, note: `quote ${agent.slice(-2)}` },
  secondsLeft: 170,
});

function deps(over: Partial<HireDeps> = {}): HireDeps {
  return {
    arkiv: {} as never,
    buyerWriter: { account: { address: BUYER } } as never,
    platformWriter: {} as never,
    payingFetch: vi.fn(async () => ({
      response: Response.json({ result: { orderId: "ord_1" } }),
      paid: {
        settlement: { transaction: "0.0.1@1.1" },
        requirements: { payTo: "0.0.5005" },
      },
    })) as never,
    evm: {
      readContract: vi.fn(async ({ args }: { args: [bigint, string] }) => args[1] !== C),
    } as never,
    registry: "0x2f30e8F1804Fe163C76918db493a441D44394D5d",
    mandateId: 3n,
    payer: "0.0.1",
    log: () => {},
    ...over,
  };
}

const quoteFetch = vi.fn(async (_url: string) => new Response("{}"));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", quoteFetch);
  vi.mocked(findListings).mockResolvedValue([listing(A), listing(B), listing(C)] as never);
  // liveQuotes is sorted cheapest first; C is cheapest but not allowed by the mandate
  vi.mocked(liveQuotes).mockResolvedValue([
    quote(C, 10_000n),
    quote(B, 30_000n),
    quote(A, 50_000n),
  ] as never);
});

describe("hire", () => {
  it("asks only mandate-allowed agents, pays the cheapest live quote, records it on Arkiv", async () => {
    const d = deps();
    const h = await hire("flights", "t1", trip, d);

    expect(quoteFetch.mock.calls.map((c) => c[0])).toEqual([
      `http://${A}/quote`,
      `http://${B}/quote`,
    ]);
    expect(h).toMatchObject({
      agent: B,
      feeUnits: 30_000n,
      hederaTx: "0.0.1@1.1",
      jobKey: "0xjob",
    });
    expect(h.rejected).toEqual([expect.stringContaining("not an allowed payee")]);
    expect(d.payingFetch).toHaveBeenCalledWith(`http://${B}/work`, expect.anything());
    const sent = JSON.parse(vi.mocked(d.payingFetch).mock.calls[0]?.[1]?.body as string);
    expect(sent.quoteKey).toBe("0xquotebb");

    expect(openJob).toHaveBeenCalledWith(
      d.buyerWriter,
      expect.objectContaining({ buyer: BUYER, seller: B, status: "paid", mandateId: 3n }),
    );
    expect(recordReceipt).toHaveBeenCalledWith(
      d.platformWriter,
      expect.objectContaining({ job: "0xjob", payTo: "0.0.5005", amountUnits: 30_000n }),
    );
    expect(rateAgent).toHaveBeenCalledWith(
      d.buyerWriter,
      expect.objectContaining({ agent: B, job: "0xjob", score: 5 }),
    );
  });

  it("an agent that fails to quote is skipped, not fatal", async () => {
    quoteFetch.mockImplementation(async (url: string) =>
      url.includes(B) ? new Response("down", { status: 503 }) : new Response("{}"),
    );
    vi.mocked(liveQuotes).mockResolvedValue([quote(A, 50_000n)] as never);
    const h = await hire("flights", "t1", trip, deps());
    expect(h.agent).toBe(A);
    expect(h.rejected).toContainEqual(expect.stringContaining("no quote (Error: HTTP 503)"));
  });

  it("refuses when no listed agent is an allowed payee", async () => {
    vi.mocked(findListings).mockResolvedValue([listing(C)] as never);
    const d = deps();
    await expect(hire("flights", "t1", trip, d)).rejects.toThrow("allowed payee in mandate #3");
    expect(d.payingFetch).not.toHaveBeenCalled();
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
});
