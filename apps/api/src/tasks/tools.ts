import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { Card, ConciergeEvent } from "@eth/shared";
import { z } from "zod";
import type { Market } from "../concierge/market";
import type { ChatLike } from "../hiring/service";
import { inputProblems } from "./check-input";
import type { OpenTaskService } from "./service";

const usdc = (u: bigint) => (Number(u) / 1e6).toFixed(2);

/** Posting a job to the whole market on Arkiv, and reading the bids agents send by themselves. */
/** The input schema an agent with this skill publishes on GET /, if one answers. */
async function publishedSchema(market: Market, skill: string) {
  for (const a of await market.agents(skill).catch(() => [])) {
    const res = await fetch(a.endpoint, { signal: AbortSignal.timeout(5000) }).catch(() => null);
    const profile = res?.ok
      ? ((await res.json().catch(() => null)) as { inputSchema?: unknown })
      : null;
    if (profile?.inputSchema) return profile.inputSchema;
  }
  return null;
}

export function taskTools(
  tasks: OpenTaskService,
  market: Market,
  chat: ChatLike,
  show: (card: Card) => void,
  emit: (event: ConciergeEvent) => void,
) {
  const postTask = betaZodTool({
    name: "post_task",
    description:
      "Post the job publicly on Arkiv as an open task: every agent on the market with this skill can bid by itself (no payment). Use it when the user wants agents to bid or to open the job to the market. Call agent_input first: `input` must fit the agents' schema exactly (every required field, real dates; for a one-way flight returnDate is the departure date). It is PUBLIC: never put names, emails or phone numbers in it. Shows the user a live bids card.",
    inputSchema: z.object({
      skill: z.string().regex(/^[a-z0-9_.-]{1,64}$/),
      title: z
        .string()
        .min(3)
        .max(160)
        .describe('short public summary, e.g. "Flight BOM→BLR, 18 Nov, 1 adult"'),
      input: z.record(z.string(), z.unknown()),
      minutes: z.number().int().min(2).max(30).default(10).describe("how long bids stay open"),
    }),
    run: async (job) => {
      // A public task with input no agent accepts gets no bids, and nobody says why: check first.
      const schema = await publishedSchema(market, job.skill);
      const problems = schema ? inputProblems(schema, job.input) : [];
      if (problems.length)
        return `Not posted: agents with this skill wouldn't accept this input (${problems.join("; ")}). Fix the input and call post_task again.`;
      emit({ type: "status", label: "Posting the task on Arkiv" });
      const card = await tasks.post(chat, job);
      show(card);
      return `Posted open task ${card.task} on Arkiv; bids close at ${card.closesAt}. Agents bid by themselves within about a minute, and the card shows them live. Tell the user in one line and stop. When they pick a bid, or ask you to take the best one, call check_bids, then hire_agent with its ref.`;
    },
  });

  const checkBids = betaZodTool({
    name: "check_bids",
    description:
      "Read the bids agents posted on an open task (free). Returns refs (q1, q2…) ranked by total cost, usable with hire_agent like quote refs.",
    inputSchema: z.object({ task: z.string().regex(/^[a-z0-9_.-]{1,64}$/) }),
    run: async ({ task }) => {
      const b = await tasks.bids(chat.id, task);
      if (!b) return `No open task ${task} in this chat.`;
      return JSON.stringify({
        status: b.status,
        closesAt: b.closesAt,
        bids: b.refs.map(({ ref, option: o }) => ({
          ref,
          agent: o.title.split(" — ")[0],
          offer: o.note,
          feeUsdc: usdc(o.feeUnits),
          totalInr: o.priced ? Math.round(o.priced.totalInr) : undefined,
        })),
        best: b.refs[0]?.ref ?? null,
        why: b.refs.length ? b.round.bestReason : "no bids yet: agents usually bid within a minute",
      });
    },
  });

  return { postTask, checkBids };
}
