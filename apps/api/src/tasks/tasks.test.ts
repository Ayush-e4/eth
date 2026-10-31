import { readBids } from "@eth/agents/hiring";
import { claimTask, postTask, setTaskStatus } from "@eth/arkiv";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HiringEnv } from "../hiring/env";
import { hiringService } from "../hiring/service";
import { testDb } from "../test/db";
import { openTaskService } from "./service";

vi.mock("@eth/agents/hiring", () => ({
  readBids: vi.fn(),
  collectQuotes: vi.fn(),
  buy: vi.fn(),
  fetchInrRates: vi.fn(async () => ({ INR: 1, USDC: 94 })),
}));
vi.mock("@eth/arkiv", () => ({
  arkivReader: vi.fn(() => ({})),
  arkivWriter: vi.fn(() => ({})),
  postTask: vi.fn(async () => ({ entityKey: `0x${"aa".repeat(32)}` })),
  claimTask: vi.fn(async () => ({ entityKey: `0x${"cc".repeat(32)}` })),
  setTaskStatus: vi.fn(async () => ({})),
}));

const CONCIERGE = "0xeE7bb1b4204C4384CFb7E497256eA1d061b397C8";
const AIRNEST = "0x65F8E30A61635AFEB3F33B5221F05B8A6FCE3E13";
const env = {
  concierge: { key: `0x${"11".repeat(32)}`, evm: CONCIERGE },
  mc: { publicClient: {} },
  registry: "0x2f30e8F1804Fe163C76918db493a441D44394D5d",
} as unknown as HiringEnv;
const chat = {
  id: "11111111-2222-3333-4444-555555555555",
  mode: "auto" as const,
  limitUnits: 300_000n,
};
const bid = {
  key: `0x${"bb".repeat(32)}`,
  agent: AIRNEST,
  title: "AirNest — budget flights",
  note: "IX1163 ₹3,800",
  feeUnits: 30_000n,
  endpoint: "http://a",
};

let tasks: ReturnType<typeof openTaskService>;
let hiring: ReturnType<typeof hiringService>;
beforeEach(async () => {
  vi.clearAllMocks();
  hiring = hiringService(await testDb(), env);
  tasks = openTaskService(env, hiring, { reader: {} as never, writer: {} as never });
});

const roundFor = (task: string) => ({
  skill: "flights",
  task,
  input: { origin: "BOM" },
  options: [bid],
  bestReason: "lowest total",
  skipped: [],
});

describe("open tasks on Arkiv", () => {
  it("posts the job publicly, owned by the concierge, capped at one payment's fee", async () => {
    const card = await tasks.post(chat, {
      skill: "flights",
      title: "Flight BOM→BLR",
      input: { origin: "BOM" },
      minutes: 99, // clamped to 30
    });
    expect(card).toMatchObject({ type: "task", skill: "flights", maxFeeUnits: "100000" });
    expect(card.task).toMatch(/^open-11111111-/);
    expect(vi.mocked(postTask).mock.calls[0]?.[1]).toMatchObject({
      poster: CONCIERGE,
      status: "open",
      maxFeeUnits: 100_000n,
    });
    expect(vi.mocked(postTask).mock.calls[0]?.[2]).toBe(30 * 60);
  });

  it("reads bids into refs that stay the same across reads, for this chat only", async () => {
    const { task } = await tasks.post(chat, {
      skill: "flights",
      title: "t",
      input: {},
      minutes: 10,
    });
    vi.mocked(readBids).mockResolvedValue(roundFor(task) as never);
    const first = await tasks.bids(chat.id, task);
    const again = await tasks.bids(chat.id, task);
    expect(first?.refs.map((r) => r.ref)).toEqual(["q1"]);
    expect(again?.refs.map((r) => r.ref)).toEqual(["q1"]); // polling doesn't mint new refs
    expect(first?.status).toBe("open");
    expect(await tasks.bids("another-chat", task)).toBeNull();
  });

  it("records the award on Arkiv once, and only for a bid on our own task", async () => {
    const { task } = await tasks.post(chat, {
      skill: "flights",
      title: "t",
      input: {},
      minutes: 10,
    });
    vi.mocked(readBids).mockResolvedValue(roundFor(task) as never);
    await tasks.bids(chat.id, task);
    // the hire tool reads the bid before paying (a hire drops its refs) and hands it over
    const held = hiring.held(chat.id, "q1");
    expect(held).not.toBeNull();
    await tasks.award(chat.id, held as NonNullable<typeof held>);
    await tasks.award(chat.id, held as NonNullable<typeof held>);
    expect(claimTask).toHaveBeenCalledOnce();
    expect(vi.mocked(claimTask).mock.calls[0]?.[1]).toEqual({
      task,
      poster: CONCIERGE,
      quote: bid.key,
      agent: AIRNEST,
    });
    expect(setTaskStatus).toHaveBeenCalledWith(
      expect.anything(),
      `0x${"aa".repeat(32)}`,
      "awarded",
    );
    expect((await tasks.bids(chat.id, task))?.status).toBe("awarded");

    // a plain quote (not a bid on a task we posted) awards nothing
    hiring.hold(chat.id, roundFor("chat-plain-quote") as never);
    await tasks.award(chat.id, { round: { task: "chat-plain-quote" }, option: bid as never });
    expect(claimTask).toHaveBeenCalledOnce();
  });
});
