import { postQuote } from "@eth/arkiv";
import { AgentProfileSchema, type TaskRequest } from "@eth/shared";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createSpecialist, type SpecialistDef } from "./server";

vi.mock("@eth/arkiv", () => ({
  arkivReader: vi.fn(() => ({})),
  arkivWriter: vi.fn(() => ({})),
  postQuote: vi.fn(async () => ({ entityKey: "0xq9", txHash: "0xt9" })),
  findListings: vi.fn(async () => []),
  publishAgent: vi.fn(async () => ({ txHash: "0xpub" })),
}));

// A non-travel agent: proves the envelope isn't tied to trips.
const BriefInput = z.object({
  question: z.string().min(5).max(300),
  sources: z.number().int().min(1).max(10).default(5),
});
type Brief = z.infer<typeof BriefInput>;

const seen: TaskRequest<Brief>[] = [];
const scout: SpecialistDef<Brief, { plan: string }, { brief: string }> = {
  name: "Scout",
  skill: "research",
  title: "Scout — research briefs with sources",
  description: "test",
  priceUnits: 30_000n,
  input: BriefInput,
  async quote(req) {
    seen.push(req);
    return {
      note: `Brief on "${req.input.question}"`,
      detail: { plan: "read" },
      itemTotal: 0,
      itemCurrency: "USD",
    };
  },
  async work() {
    return { brief: "…" };
  },
};

const key = generatePrivateKey();
const { app } = createSpecialist(scout, {
  identity: { key, evm: privateKeyToAccount(key).address, hederaAccount: "0.0.7007" },
  baseUrl: "http://scout",
  facilitator: { verify: vi.fn(), settle: vi.fn() } as never,
  usdcTokenId: "0.0.429274",
  executorId: "0.0.11102395",
});

const post = (path: string, body: unknown) =>
  app.request(`http://scout${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  seen.length = 0;
});

describe("shared task envelope", () => {
  it("publishes the JSON Schema of its input on the profile", async () => {
    const profile = AgentProfileSchema.parse(await (await app.request("http://scout/")).json());
    expect(profile.skill).toBe("research");
    expect(profile.inputSchema).toMatchObject({
      type: "object",
      properties: { question: { type: "string" }, sources: { type: "integer" } },
      required: expect.arrayContaining(["question"]),
    });
  });

  it("quotes a non-travel task and applies the input schema's defaults", async () => {
    const res = await post("/quote", {
      task: "brief-1",
      skill: "research",
      input: { question: "How do UPI refunds work?" },
    });
    expect(res.status).toBe(200);
    expect(seen[0]?.input).toEqual({ question: "How do UPI refunds work?", sources: 5 });
    expect(postQuote).toHaveBeenCalledOnce();
  });

  it("refuses a task for a different skill", async () => {
    const res = await post("/quote", { task: "t1", skill: "flights", input: {} });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "wrong_skill" });
    expect(postQuote).not.toHaveBeenCalled();
  });

  it("refuses input that doesn't fit its schema, saying what's wrong", async () => {
    const res = await post("/quote", { task: "t1", skill: "research", input: { question: "?" } });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; issues: { path: string[] }[] };
    expect(body.error).toBe("invalid_input");
    expect(body.issues[0]?.path).toEqual(["question"]);
  });

  it("refuses a malformed envelope or non-JSON body", async () => {
    expect((await post("/quote", { task: "NOT VALID", skill: "research", input: {} })).status).toBe(
      400,
    );
    expect((await post("/quote", "not json")).status).toBe(400);
    expect((await post("/work", { task: "t1", skill: "research", input: {} })).status).toBe(422);
  });

  it("checks the envelope on /work before asking for payment", async () => {
    const res = await post("/work", { task: "t1", skill: "flights", input: {}, quoteKey: "0xq9" });
    expect(res.status).toBe(400); // never reached the 402 paywall
  });
});
