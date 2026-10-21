import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages";
import { anthropic, MODEL } from "./claude";
import { explainRun } from "./explain";
import type { HireDeps } from "./hire";
import { planTrip } from "./plan";
import { liteApiResearch, MCP_BETA } from "./research";
import type { TripRun } from "./run";
import { newRunState, tripTools } from "./tools";

const SYSTEM = `You book trips on an open marketplace of AI agents. You spend the traveller's money only
through hire_agent, which pays an agent's fee from a capped spending mandate. Be decisive and brief.

1. Call get_quotes for "flights" and for "hotels" (in parallel).
2. If the traveller stated hotel preferences (quiet, beachfront, family-friendly, …), check every hotel
   option with the liteapi tools before hiring — reviews, or ask the hotel a question — and say in the
   caveats whether it matches. Also use web_search once for one useful fact about the destination on those
   dates (an event, the weather) and put it in the itinerary.
3. For each skill choose one quote. Default: rank 1 (lowest total cost to the traveller). Choose another only
   for a concrete reason from the traveller's words or what your checks found, and say so in the reason.
   With a budget, keep flights + hotel within it when possible; otherwise pick the cheapest and say so.
4. hire_agent once per skill. If a hire fails the fee is refunded; you may hire the next option once.
5. Call finish exactly once, last. itinerary: flight numbers, times, hotel and booking references — only
   from tool results. spends: each agent fee in USDC and why that agent won, with numbers from get_quotes.
   caveats: these are SANDBOX bookings (no real tickets or rooms); how the travel dates were read from the
   request; anything failed, pending or unverified.
Never invent prices, times, names or references.`;

export interface AgentOptions {
  liteApiKey?: string; // sandbox key → read-only LiteAPI research tools via MCP
  webSearch?: boolean;
  today?: Date;
}

/**
 * The orchestrator as an agent: dates are planned and checked in code first, then Claude runs
 * the marketplace with tools (Tool Runner) — and the mandate onchain caps what it can spend.
 */
export async function runTripAgent(
  request: string,
  d: HireDeps,
  opts: AgentOptions = {},
): Promise<TripRun> {
  const trip = await planTrip(request, opts.today);
  const task = `trip-${trip.destination.toLowerCase()}-${Date.now().toString(36)}`;
  d.log(
    `plan: ${trip.adults} adult(s) ${trip.origin}→${trip.destination} ${trip.departDate}…${trip.returnDate}${trip.returnFlight ? " (return flight)" : ""} (task ${task})`,
  );

  const state = newRunState(task, trip);
  const own = tripTools(state, d);
  const research = opts.liteApiKey ? liteApiResearch(opts.liteApiKey) : undefined;
  const runner = anthropic().beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 16000,
    max_iterations: 16,
    output_config: { effort: "medium" },
    ...(research ? { betas: [MCP_BETA], mcp_servers: [research.server] } : {}),
    tools: [
      own.getQuotes,
      own.hireAgent,
      own.finish,
      ...(opts.webSearch === false
        ? []
        : // Basic variant: Haiku forms its input reliably; the _20260209 (dynamic filtering) one
          // is documented for Opus/Sonnet and Haiku sent malformed inputs to it in our tests.
          [{ type: "web_search_20250305" as const, name: "web_search" as const, max_uses: 2 }]),
      ...(research ? [research.toolset] : []),
    ],
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: `Traveller's request: ${request}\n\nPlanned trip (dates already checked): ${JSON.stringify(trip)}`,
      },
    ],
  });

  for await (const message of runner) {
    logSteps(message, d.log);
    // Server tools (web search, MCP) can pause a long turn; the runner doesn't resume it itself.
    if (message.stop_reason === "pause_turn") {
      runner.pushMessages({ role: "assistant", content: message.content });
    }
  }
  const final = await runner.done();
  if (final.stop_reason === "refusal") state.failures.push("Claude declined to continue");
  if (final.stop_reason === "max_tokens") state.failures.push("Claude ran out of output tokens");

  const hires = [...state.hires.values()];
  for (const skill of ["flights", "hotels"]) {
    if (!state.hires.has(skill)) state.failures.push(`${skill}: not booked`);
  }
  // If Claude never called finish, still give the traveller a grounded explanation.
  const explanation = state.explanation ?? (await explainRun(trip, hires, state.failures));
  return { task, trip, hires, failures: state.failures, explanation };
}

/** One log line per thing Claude decided to do, so a demo shows the agent thinking in actions. */
function logSteps(message: BetaMessage, log: (line: string) => void) {
  for (const block of message.content) {
    if (block.type === "tool_use") {
      const input = block.input as Record<string, unknown>;
      if (block.name === "hire_agent") log(`claude → hire_agent ${input.skill}: ${input.reason}`);
      else if (block.name !== "finish") log(`claude → ${block.name} ${JSON.stringify(input)}`);
    } else if (block.type === "server_tool_use") {
      log(`claude → ${block.name} ${JSON.stringify(block.input)}`);
    } else if (block.type === "mcp_tool_use") {
      log(`claude → liteapi.${block.name} ${JSON.stringify(block.input).slice(0, 160)}`);
    } else if (block.type === "web_search_tool_result" && !Array.isArray(block.content)) {
      log(`web_search failed: ${block.content.error_code}`);
    } else if (block.type === "mcp_tool_result" && block.is_error) {
      log(`liteapi tool failed: ${JSON.stringify(block.content).slice(0, 160)}`);
    }
  }
}
