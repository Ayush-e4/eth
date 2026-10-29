import { describe, expect, it, vi } from "vitest";
import type { Hire } from "../orchestrator/hire";
import type { QuoteOption, QuoteRound } from "../orchestrator/quotes";
import type { Trip } from "../trip";
import { type TripMintDeps, tripmint } from "./tripmint";

const ME = "0xd422f7321434f007ed56057bad11a7282365e1ed";
const AIRNEST = "0x65f8e30a61635afeb3f33b5221f05b8a6fce3e13";
const STAYWISE = "0x78ef54682bce53b3eb9bf9432952423aaa274ad1";
const trip = { destinationName: "Goa" } as Trip;

const option = (agent: string, title: string, fee: bigint, inr: number): QuoteOption =>
  ({
    key: `0x${title}`,
    agent,
    title: `${title} — x`,
    note: `${title} offer`,
    feeUnits: fee,
    endpoint: "http://a",
    priced: { totalInr: inr },
  }) as QuoteOption;

const round = (skill: string, options: QuoteOption[]): QuoteRound => ({
  skill,
  task: `t-${skill[0]}`,
  input: trip,
  options,
  bestReason: "lowest",
  skipped: [],
});

const hired = (skill: string, agent: string): Hire =>
  ({
    skill,
    agent,
    agentTitle: `${skill} agent — x`,
    quoteNote: "n",
    feeUnits: 30_000n,
    hederaTx: `0.0.1@${skill}`,
    jobKey: `0xjob${skill}`,
    result: { ref: skill },
  }) as Hire;

function deps(over: Partial<TripMintDeps> = {}): TripMintDeps {
  return {
    me: ME,
    quoteDeps: async () => ({}) as never,
    readMandate: async () => ({ agent: ME, active: true, remaining: 70_000n, allowed: true }),
    hireDeps: async () => ({}) as never,
    collect: vi.fn(async (skill: string) =>
      skill === "flights"
        ? round(skill, [option(AIRNEST, "AirNest", 30_000n, 3_805)])
        : round(skill, [
            // another planner never gets picked: no chains of planners
            { ...option(ME, "TripMint", 50_000n, 1), subcontract: {} } as QuoteOption,
            option(STAYWISE, "StayWise", 40_000n, 6_200),
          ]),
    ) as never,
    purchase: vi.fn(async (r: QuoteRound, pick: QuoteOption) =>
      hired(r.skill, pick.agent),
    ) as never,
    ...over,
  };
}

const req = { task: "chat-1", skill: "trips", input: trip };
const delegation = { mandateId: "35", payer: "0.0.11045937" };

describe("TripMint", () => {
  it("quotes a flight and a hotel, and names exactly who it will pay and how much", async () => {
    const q = await tripmint(deps()).quote(req);
    expect(q.itemTotal).toBe(10_005);
    expect(q.itemCurrency).toBe("INR");
    expect(q.note).toBe("Flight: AirNest offer (AirNest); Hotel: StayWise offer (StayWise)");
    expect(q.subcontract).toEqual({
      budgetUnits: "70000",
      payees: [
        { name: "AirNest", skill: "flights", agent: AIRNEST },
        { name: "StayWise", skill: "hotels", agent: STAYWISE },
      ],
    });
  });

  it("checks its sub-mandate on the chain before its fee is taken", async () => {
    const plan = (await tripmint(deps()).quote(req)).detail;
    const check = (d: TripMintDeps, del: typeof delegation | null = delegation) =>
      tripmint(d).check?.({ ...req, delegation: del ?? undefined }, plan);
    expect(await check(deps())).toBeNull();
    expect(await check(deps(), null)).toMatch(/needs a sub-mandate/);
    const read = (m: object) =>
      deps({
        readMandate: async () => ({
          agent: ME,
          active: true,
          remaining: 70_000n,
          allowed: true,
          ...m,
        }),
      });
    expect(await check(read({ agent: AIRNEST }))).toMatch(/isn't for TripMint/);
    expect(await check(read({ active: false }))).toMatch(/revoked or expired/);
    expect(await check(read({ remaining: 69_999n }))).toMatch(/too small/);
    expect(await check(read({ allowed: false }))).toMatch(/doesn't allow/);
  });

  it("hires both agents under the sub-mandate and reports each payment", async () => {
    const d = deps();
    const t = tripmint(d);
    const plan = (await t.quote(req)).detail;
    const out = (await t.work({ ...req, delegation }, plan)) as { hires: { agent: string }[] };
    expect(out).toMatchObject({
      subMandateId: "35",
      hires: [
        { skill: "flights", agent: AIRNEST, feeUnits: "30000", hederaTx: "0.0.1@flights" },
        { skill: "hotels", agent: STAYWISE, hederaTx: "0.0.1@hotels" },
      ],
    });
    expect(d.purchase).toHaveBeenCalledTimes(2);
  });

  it("fails (and is refunded) if nothing got booked, but reports a half-done trip", async () => {
    const plan = (await tripmint(deps()).quote(req)).detail;
    const failing = deps({
      purchase: vi.fn(async () => {
        throw new Error("no seats");
      }) as never,
    });
    await expect(tripmint(failing).work({ ...req, delegation }, plan)).rejects.toThrow("no seats");

    const halfway = deps({
      purchase: vi
        .fn()
        .mockResolvedValueOnce(hired("flights", AIRNEST))
        .mockRejectedValueOnce(new Error("hotel sold out")) as never,
    });
    expect(await tripmint(halfway).work({ ...req, delegation }, plan)).toMatchObject({
      hires: [{ skill: "flights" }],
      failed: "Error: hotel sold out",
    });
  });
});
