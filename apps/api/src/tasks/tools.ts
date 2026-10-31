import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { Card, ConciergeEvent } from "@eth/shared";
import { z } from "zod";
import type { ChatLike } from "../hiring/service";
import type { OpenTaskService } from "./service";

const usdc = (u: bigint) => (Number(u) / 1e6).toFixed(2);

/** Posting a job to the whole market on Arkiv, and reading the bids agents send by themselves. */
export function taskTools(
  tasks: OpenTaskService,
  chat: ChatLike,
  show: (card: Card) => void,
  emit: (event: ConciergeEvent) => void,
) {
  const postTask = betaZodTool({
    name: "post_task",
    description:
      "Post the job publicly on Arkiv as an open task: every agent on the market with this skill can bid by itself (no payment). Use it when the user wants agents to bid or to open the job to the market. `input` is the same as for get_quotes and is PUBLIC: never put names, emails or phone numbers in it. Shows the user a live bids card.",
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
