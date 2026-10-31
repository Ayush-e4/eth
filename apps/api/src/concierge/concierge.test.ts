import { findAgents, findListings } from "@eth/arkiv";
import type { Card, ConciergeEvent } from "@eth/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { arkivMarket, type Market } from "./market";
import { conciergeTools } from "./tools";

vi.mock("@eth/arkiv", () => ({
  arkivReader: vi.fn(() => ({})),
  findAgents: vi.fn(),
  findListings: vi.fn(),
}));

const STAYWISE = "0x78Ef54682bCe53b3eB9bF9432952423aAA274aD1";
const GHOST = "0x1111111111111111111111111111111111111111";
const profile = (agent: string, name: string, skill: string) => ({
  key: "0x1",
  record: {
    agent,
    name,
    skill,
    hederaAccount: "0.0.1",
    description: `${name} desc`,
    endpoint: "http://a",
  },
});
const listing = (agent: string, skill: string, priceUnits: bigint) => ({
  key: "0x2",
  record: {
    agent,
    skill,
    priceUnits,
    acceptsCredits: false,
    title: `${skill} by ${agent.slice(0, 6)}`,
    endpoint: "http://a",
  },
});

beforeEach(() => vi.clearAllMocks());

describe("arkivMarket", () => {
  it("joins profiles to listings and drops agents with no live listing", async () => {
    vi.mocked(findAgents).mockResolvedValue([
      profile(STAYWISE, "StayWise", "hotels"),
      profile(STAYWISE.toLowerCase(), "StayWise", "hotels"), // duplicate profile
      profile(GHOST, "Ghost", "hotels"), // never listed anything
    ] as never);
    vi.mocked(findListings).mockResolvedValue([listing(STAYWISE, "hotels", 40_000n)] as never);
    const agents = await arkivMarket({} as never).agents("hotels");
    expect(agents).toEqual([
      {
        name: "StayWise",
        skill: "hotels",
        title: "hotels by 0x78Ef",
        description: "StayWise desc",
        priceUnits: "40000",
        agent: STAYWISE,
        endpoint: "http://a",
      },
    ]);
    expect(findAgents).toHaveBeenCalledWith({}, { skill: "hotels" });
  });
});

describe("arkivMarket names", () => {
  it("adds a short address when two agents share a name", async () => {
    vi.mocked(findAgents).mockResolvedValue([
      profile(STAYWISE, "StayWise", "hotels"),
      profile(GHOST, "StayWise", "hotels"),
    ] as never);
    vi.mocked(findListings).mockResolvedValue([
      listing(STAYWISE, "hotels", 40_000n),
      listing(GHOST, "hotels", 10_000n),
    ] as never);
    const names = (await arkivMarket({} as never).agents()).map((a) => a.name);
    expect(names).toEqual(["StayWise · 0x78Ef…4aD1", "StayWise · 0x1111…1111"]);
  });
});

describe("concierge tools", () => {
  const agent = {
    name: "StayWise",
    skill: "hotels",
    title: "best-value hotel",
    description: "x".repeat(500),
    priceUnits: "40000",
    agent: STAYWISE,
    endpoint: "http://a",
  };
  let cards: Card[];
  let events: ConciergeEvent[];
  const market = (list: (typeof agent)[]): Market => ({ agents: vi.fn(async () => list) });
  const tools = (m: Market) =>
    conciergeTools(
      m,
      (c) => cards.push(c),
      (e) => events.push(e),
    );

  beforeEach(() => {
    cards = [];
    events = [];
  });

  it("find_agents shows a card and gives Claude fees in USDC with trimmed descriptions", async () => {
    const out = JSON.parse(
      String(await tools(market([agent])).findAgents.run({ skill: "hotels" })),
    );
    expect(out).toEqual([
      {
        name: "StayWise",
        skill: "hotels",
        title: "best-value hotel",
        feeUsdc: "0.04",
        description: "x".repeat(300),
        identity: "no on-chain identity",
      },
    ]);
    expect(cards).toEqual([{ type: "agents", skill: "hotels", agents: [agent] }]);
    expect(events).toEqual([{ type: "status", label: "Looking at the market" }]);
  });

  it("find_agents caps a card at 6 agents and says so plainly when nobody offers a skill", async () => {
    await tools(market(Array.from({ length: 9 }, () => agent))).findAgents.run({});
    expect((cards[0] as { agents: unknown[] }).agents).toHaveLength(6);
    cards = [];
    const none = JSON.parse(String(await tools(market([])).findAgents.run({ skill: "food" })));
    expect(none).toEqual({ none: "No agent on the market offers food right now." });
    expect(cards).toEqual([]);
  });

  it("show_options shows a choices card", async () => {
    const input = {
      question: "Which hotel?",
      options: [
        { label: "Dunhill", reply: "Book Dunhill" },
        { label: "Park Inn", detail: "cheaper", reply: "Book Park Inn" },
      ],
    };
    await tools(market([])).showOptions.run(input);
    expect(cards).toEqual([{ type: "options", ...input }]);
  });
});

describe("dates in the concierge's prompt", () => {
  it("names today and lists the coming days in India time", async () => {
    const { calendar, today } = await import("./concierge");
    const fri = new Date("2026-10-29T20:00:00Z"); // 01:30 on Friday 30 Oct in India
    expect(today(fri)).toBe("Friday, 30 October 2026");
    expect(calendar(fri, 3)).toBe("Fri 30 Oct; Sat 31 Oct; Sun 1 Nov");
  });
});
