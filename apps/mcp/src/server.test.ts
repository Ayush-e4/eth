import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "./server";
import { NO_MANDATE, type ToolDeps } from "./tools";

const AIRNEST = {
  name: "AirNest",
  skill: "flights",
  title: "AirNest — budget flights",
  description: "LiteAPI flights",
  feeUnits: 30_000n,
  agent: "0x65F8E30A61635AFEB3F33B5221F05B8A6FCE3E13",
  endpoint: "http://localhost:8413",
};
const option = {
  key: "0xq",
  agent: AIRNEST.agent,
  title: AIRNEST.title,
  note: "IX1163 ₹14,282",
  feeUnits: 30_000n,
  endpoint: AIRNEST.endpoint,
  priced: { totalInr: 14_285 },
};
const round = {
  skill: "flights",
  task: "t",
  input: {},
  options: [option],
  bestReason: "lowest total",
  skipped: [],
};

let hire: ReturnType<typeof vi.fn>;
const deps = (paying = true): ToolDeps => ({
  agents: vi.fn(async () => [AIRNEST]),
  quotes: vi.fn(async () => round as never),
  fetchProfile: vi.fn(async () => ({
    inputSchema: { type: "object", properties: { origin: { type: "string" } } },
  })),
  hire: paying ? (hire as never) : null,
  budget: paying
    ? vi.fn(async () => ({ remainingUnits: 970_000n, expiresAt: 1_800_000_000 }))
    : null,
});

async function connect(d: ToolDeps) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([createServer(d).connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as {
      content: { text: string }[];
      isError?: boolean;
    };
    return { text: r.content[0]?.text ?? "", isError: !!r.isError };
  };
  return { client, call };
}

beforeEach(() => {
  hire = vi.fn(async () => ({
    agentTitle: AIRNEST.title,
    feeUnits: 30_000n,
    hederaTx: "0.0.1@1.2",
    jobKey: "0xjob",
    result: { reference: "FH-1" },
  }));
});

describe("AgentNet MCP server", () => {
  it("lists the market tools, with hire marked as not read-only", async () => {
    const { client } = await connect(deps());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "find_agents",
      "agent_input",
      "get_quotes",
      "hire",
      "budget",
    ]);
    expect(tools.find((t) => t.name === "hire")?.annotations?.readOnlyHint).toBe(false);
    expect(tools.find((t) => t.name === "get_quotes")?.annotations?.readOnlyHint).toBe(true);
  });

  it("finds agents with fees in USDC, and an agent's input schema", async () => {
    const { call } = await connect(deps());
    expect(JSON.parse((await call("find_agents", { skill: "flights" })).text)).toEqual([
      {
        name: "AirNest",
        skill: "flights",
        does: "AirNest — budget flights",
        fee: "0.03 USDC",
        agent: AIRNEST.agent,
      },
    ]);
    expect((await call("agent_input", { skill: "flights" })).text).toContain('"origin"');
  });

  it("quotes for free with short refs, then hires once per quote and returns proof", async () => {
    const { call } = await connect(deps());
    const q = JSON.parse(
      (await call("get_quotes", { skill: "flights", input: { origin: "BOM" } })).text,
    );
    expect(q).toMatchObject({
      best: "q1",
      quotes: [{ ref: "q1", agent: "AirNest", fee: "0.03 USDC", totalInr: 14_285 }],
    });
    expect(hire).not.toHaveBeenCalled(); // quotes never pay

    const h = JSON.parse((await call("hire", { quote: "q1", reason: "cheapest" })).text);
    expect(h).toMatchObject({
      status: "hired",
      fee: "0.03 USDC",
      paymentOnHashScan: "https://hashscan.io/testnet/transaction/0.0.1@1.2",
      result: { reference: "FH-1" },
    });
    expect((await call("hire", { quote: "q1", reason: "again" })).text).toMatch(
      /expired or doesn't exist/,
    );
    expect(hire).toHaveBeenCalledOnce();
  });

  it("can browse and quote without a mandate, but never pays", async () => {
    const { call } = await connect(deps(false));
    await call("get_quotes", { skill: "flights", input: {} });
    expect((await call("hire", { quote: "q1", reason: "x" })).text).toBe(NO_MANDATE);
    expect((await call("budget")).text).toBe(NO_MANDATE);
  });

  it("reports what's left to spend", async () => {
    const { call } = await connect(deps());
    expect((await call("budget")).text).toMatch(/^Left to spend: 0\.97 USDC, until 2027-/);
  });

  it("turns a failed payment into a tool error the model can read", async () => {
    hire.mockRejectedValueOnce(new Error("[flights] hire failed: HTTP 402 OverBudget"));
    const { call } = await connect(deps());
    await call("get_quotes", { skill: "flights", input: {} });
    expect(await call("hire", { quote: "q1", reason: "x" })).toEqual({
      text: "[flights] hire failed: HTTP 402 OverBudget",
      isError: true,
    });
  });

  it("rejects malformed refs before anything runs", async () => {
    const { call } = await connect(deps());
    expect((await call("hire", { quote: "0xdeadbeef", reason: "x" })).isError).toBe(true);
    expect(hire).not.toHaveBeenCalled();
  });
});
