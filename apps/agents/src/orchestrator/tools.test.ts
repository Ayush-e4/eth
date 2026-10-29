import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Trip } from "../trip";
import { buy } from "./hire";
import { collectQuotes, type QuoteOption, type QuoteRound } from "./quotes";
import { LITEAPI_READ_ONLY, liteApiResearch } from "./research";
import { newRunState, tripTools } from "./tools";

vi.mock("./quotes", () => ({ collectQuotes: vi.fn() }));
vi.mock("./hire", () => ({ buy: vi.fn() }));

const trip = {
  destinationName: "Goa",
  departDate: "2026-10-23",
  returnDate: "2026-10-25",
  returnFlight: true,
} as Trip;
const option = (key: string, title: string, totalInr: number): QuoteOption =>
  ({
    key,
    agent: "0x00000000000000000000000000000000000000aa",
    title,
    note: `${title} offer`,
    feeUnits: 30_000n,
    endpoint: "http://agent",
    priced: { totalInr, itemInr: totalInr - 3, feeInr: 3 },
  }) as unknown as QuoteOption;
const round = (): QuoteRound => ({
  skill: "flights",
  task: "t1",
  input: {},
  options: [option("0xq1", "AirNest", 14_282), option("0xq2", "SkyHop", 14_817)],
  bestReason: "lowest total",
  skipped: [],
});

function setup() {
  const state = newRunState("t1", trip);
  const { getQuotes, hireAgent, finish } = tripTools(state, {} as never);
  return { state, getQuotes, hireAgent, finish };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(collectQuotes).mockImplementation(async () => round());
  vi.mocked(buy).mockImplementation(
    async (_r, pick) => ({ hederaTx: "0.0.1@1", result: { ref: pick.key } }) as never,
  );
});

describe("orchestrator tools", () => {
  it("returns ranked quotes Claude can choose from", async () => {
    const { getQuotes } = setup();
    const out = JSON.parse((await getQuotes.run({ skill: "flights" })) as string);
    expect(out.defaultPick).toBe("0xq1");
    expect(out.options[1]).toMatchObject({ rank: 2, quoteKey: "0xq2", totalInr: 14_817 });
  });

  it("won't hire before quotes, or with a quote it never saw", async () => {
    const { getQuotes, hireAgent } = setup();
    await expect(
      hireAgent.run({ skill: "flights", quoteKey: "0xq1", reason: "cheapest" }),
    ).rejects.toThrow("Call get_quotes");
    await getQuotes.run({ skill: "flights" });
    await expect(
      hireAgent.run({ skill: "flights", quoteKey: "0xmadeup", reason: "cheapest" }),
    ).rejects.toThrow("Unknown quoteKey");
    expect(buy).not.toHaveBeenCalled();
  });

  it("lets Claude pick a non-default quote, recording its reason and the rank", async () => {
    const { state, getQuotes, hireAgent } = setup();
    await getQuotes.run({ skill: "flights" });
    await hireAgent.run({
      skill: "flights",
      quoteKey: "0xq2",
      reason: "traveller asked for Duffel",
    });
    const choice = vi.mocked(buy).mock.calls[0]?.[4];
    expect(choice).toContain("traveller asked for Duffel [rank 2 of 2:");
    expect(state.hires.has("flights")).toBe(true);
  });

  it("tells Claude the booked dates so it never has to guess them", async () => {
    const { getQuotes, hireAgent } = setup();
    vi.mocked(collectQuotes).mockImplementation(async () => ({ ...round(), skill: "hotels" }));
    await getQuotes.run({ skill: "hotels" });
    const out = JSON.parse(
      (await hireAgent.run({ skill: "hotels", quoteKey: "0xq1", reason: "cheapest" })) as string,
    );
    expect(out.dates).toEqual({ checkin: "2026-10-23", checkout: "2026-10-25" });
  });

  it("never books the same skill twice", async () => {
    const { getQuotes, hireAgent } = setup();
    await getQuotes.run({ skill: "flights" });
    await hireAgent.run({ skill: "flights", quoteKey: "0xq1", reason: "cheapest" });
    await expect(
      hireAgent.run({ skill: "flights", quoteKey: "0xq2", reason: "another" }),
    ).rejects.toThrow("already booked");
    expect(buy).toHaveBeenCalledTimes(1);
  });

  it("after a failed (refunded) hire, uses up that quote and allows exactly one retry", async () => {
    const { state, getQuotes, hireAgent } = setup();
    vi.mocked(buy).mockRejectedValue(new Error("HTTP 502 work_failed — fee refunded: 0.0.9@1"));
    await getQuotes.run({ skill: "flights" });
    await expect(
      hireAgent.run({ skill: "flights", quoteKey: "0xq1", reason: "cheapest" }),
    ).rejects.toThrow("That quote is used up");
    await expect(
      hireAgent.run({ skill: "flights", quoteKey: "0xq1", reason: "again" }),
    ).rejects.toThrow("Unknown quoteKey");
    await expect(
      hireAgent.run({ skill: "flights", quoteKey: "0xq2", reason: "next best" }),
    ).rejects.toThrow("used up");
    await getQuotes.run({ skill: "flights" });
    await expect(
      hireAgent.run({ skill: "flights", quoteKey: "0xq1", reason: "third try" }),
    ).rejects.toThrow("Already tried 2");
    expect(buy).toHaveBeenCalledTimes(2);
    expect(state.failures).toHaveLength(2);
  });

  it("saves Claude's explanation from finish", async () => {
    const { state, finish } = setup();
    const explanation = { headline: "Booked", itinerary: [], spends: [], caveats: ["sandbox"] };
    await finish.run(explanation);
    expect(state.explanation).toEqual(explanation);
  });
});

describe("LiteAPI research (MCP)", () => {
  it("allows only read-only tools, everything else off by default", () => {
    const { toolset, server } = liteApiResearch("sand_abc");
    expect(toolset.default_config).toEqual({ enabled: false });
    expect(Object.keys(toolset.configs ?? {})).toEqual([...LITEAPI_READ_ONLY]);
    expect(LITEAPI_READ_ONLY.some((t) => /book|vouchers|loyalt|cancel/.test(t))).toBe(false);
    expect(server.name).toBe(toolset.mcp_server_name);
  });

  it("refuses non-sandbox keys", () => {
    expect(() => liteApiResearch("prod_abc")).toThrow("sandbox");
  });
});
