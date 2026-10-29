import { buy, collectQuotes } from "@eth/agents/hiring";
import { getAddress } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatStore } from "../chats/store";
import type { Db } from "../db/client";
import { hires, mandates, users } from "../db/schema";
import { testDb } from "../test/db";
import type { HiringEnv } from "./env";
import { hiringService } from "./service";

vi.mock("@eth/agents/hiring", () => ({
  collectQuotes: vi.fn(),
  buy: vi.fn(),
  fetchInrRates: vi.fn(async () => ({ INR: 1, USDC: 94 })),
}));
vi.mock("@eth/arkiv", () => ({
  arkivReader: vi.fn(() => ({})),
  arkivWriter: vi.fn(() => ({})),
  findAgents: vi.fn(async () => [
    { record: { agent: AIRNEST, skill: "flights", name: "AirNest" } },
    { record: { agent: STAYWISE, skill: "hotels", name: "StayWise" } },
  ]),
}));

const AIRNEST = "0x65F8E30A61635AFEB3F33B5221F05B8A6FCE3E13";
const STAYWISE = "0x78Ef54682BCE53B3eb9bf9432952423AAa274AD1";
const TRIPMINT = "0xd422f7321434f007Ed56057BAd11a7282365e1ed";
const env = {
  concierge: { key: `0x${"11".repeat(32)}`, evm: "0xeE7bb1b4204C4384CFb7E497256eA1d061b397C8" },
  demo: {
    key: `0x${"22".repeat(32)}`,
    evm: "0x0000000000000000000000000000000000000d3d",
    account: "0.0.1001",
  },
  mc: { publicClient: {}, chain: { id: 296 } },
  registry: "0x2f30e8F1804Fe163C76918db493a441D44394D5d",
  registryId: "0.0.11102395",
  usdc: "0x0000000000000000000000000000000000068cda",
  usdcTokenId: "0.0.429274",
  mirrorUrl: "https://mirror",
} as unknown as HiringEnv;

const option = {
  key: "0xquote",
  agent: AIRNEST,
  title: "AirNest — budget flights",
  note: "IX1163 ₹14,282",
  feeUnits: 30_000n,
  endpoint: "http://a",
};
const round = {
  skill: "flights",
  task: "t",
  input: {},
  options: [option],
  bestReason: "lowest total",
  skipped: [],
};

let db: Db;
let chat: Awaited<ReturnType<ReturnType<typeof chatStore>["create"]>>;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(collectQuotes).mockResolvedValue(round as never);
  vi.mocked(buy).mockResolvedValue({
    skill: "flights",
    agent: AIRNEST,
    agentTitle: "AirNest",
    quoteNote: "IX1163",
    feeUnits: 30_000n,
    hederaTx: "0.0.1001@1.2",
    jobKey: "0xjob",
    result: { ref: "FH-1" },
  } as never);
  db = await testDb();
  const [u] = await db.insert(users).values({ isDemo: true }).returning();
  chat = await chatStore(db).create(u as never);
});

const giveMandate = (payees: string[]) =>
  db.insert(mandates).values({
    chatId: chat.id,
    mandateId: 7n,
    owner: env.demo.evm,
    payer: "0.0.1001",
    budgetUnits: 300_000n,
    payees,
    expiresAt: new Date(Date.now() + 3_600_000),
  });

describe("agents that hire agents (sub-mandates)", () => {
  it("gives an agent that hires agents its own slice of the limit, and records all three payments", async () => {
    const getMandate = vi.fn(async () => ({ perPaymentCap: 100_000n, expiresAt: 4_000_000_000n }));
    const createSubMandate = vi.fn(async () => ({ id: 35n }));
    const e = { ...env, mc: { ...env.mc, getMandate, createSubMandate } } as unknown as HiringEnv;
    const planner = {
      ...option,
      agent: TRIPMINT,
      title: "TripMint — trips",
      feeUnits: 50_000n,
      subcontract: {
        budgetUnits: "70000",
        payees: [
          { name: "Cheap Air (claims)", skill: "flights", agent: AIRNEST },
          { name: "x", skill: "hotels", agent: STAYWISE },
        ],
      },
    };
    vi.mocked(collectQuotes).mockResolvedValue({
      ...round,
      skill: "trips",
      options: [planner],
    } as never);
    const s = hiringService(db, e);
    await s.quotes(chat, "trips", {});
    // The limit names the planner and everyone it will pay, with names from Arkiv.
    const ask = await s.hire(chat, "q1", "x", "trip");
    expect(ask.status === "needs_limit" && ask.card.payees.map((p) => p.name)).toEqual([
      "TripMint",
      "AirNest",
      "StayWise",
    ]);

    await giveMandate([TRIPMINT, AIRNEST, STAYWISE]);
    const sub = (skill: string, agent: string) => ({
      skill,
      agent,
      title: skill,
      feeUnits: "35000",
      hederaTx: `0.0.1@${skill}`,
      jobKey: `0x${skill}`,
      result: {},
    });
    vi.mocked(buy).mockResolvedValueOnce({
      skill: "trips",
      agent: TRIPMINT,
      agentTitle: "TripMint",
      quoteNote: "both",
      feeUnits: 50_000n,
      hederaTx: "0.0.1@trip",
      jobKey: "0xtrip",
      result: {
        subMandateId: "35",
        hires: [
          sub("flights", AIRNEST),
          sub("hotels", STAYWISE),
          sub("hotels", "0x1111111111111111111111111111111111111111"), // not in the slice: ignored
        ],
      },
    } as never);
    const out = await s.hire(chat, "q1", "x", "trip");
    expect(out.status === "hired" && out.card).toMatchObject({
      subMandateId: "35",
      subHires: [{ skill: "flights" }, { skill: "hotels" }],
    });
    const [auth, payees] = (createSubMandate.mock.calls[0] as unknown[]).slice(1);
    expect(auth).toMatchObject({
      parentId: 7n,
      agent: TRIPMINT,
      budget: 70_000n,
      perPaymentCap: 70_000n,
    });
    expect(payees).toEqual([getAddress(AIRNEST), STAYWISE]); // checksummed for the chain
    expect(vi.mocked(buy).mock.calls.at(-1)?.[5]).toEqual({
      mandateId: "35",
      payer: "0.0.1001",
    });
    const rows = await db.select().from(hires);
    expect(rows.map((r) => [r.skill, r.mandateId])).toEqual([
      ["trips", 7n],
      ["flights", 35n],
      ["hotels", 35n],
    ]);
  });

  it("won't offer a planner whose plan names agents that aren't on the market", async () => {
    vi.mocked(collectQuotes).mockResolvedValue({
      ...round,
      options: [
        {
          ...option,
          agent: TRIPMINT,
          subcontract: {
            budgetUnits: "70000",
            payees: [{ name: "Totally StayWise", skill: "hotels", agent: TRIPMINT }],
          },
        },
      ],
    } as never);
    const { refs, round: r } = await hiringService(db, env).quotes(chat, "trips", {});
    expect(refs).toEqual([]);
    expect(r.skipped[0]).toMatch(/couldn't verify/);
  });
});
