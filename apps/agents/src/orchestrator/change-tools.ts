import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { openJob, recordReceipt, setJobStatus } from "@eth/arkiv";
import type { LocalAccount } from "viem";
import { z } from "zod";
import { signedHeaders } from "../auth";
import type { TripRecord } from "../trips";
import { type Explanation, ExplanationSchema } from "./explain";
import type { HireDeps } from "./hire";

/** What the traveller has to say yes to first. */
export const APPROVALS = ["pay_more", "lose_money"] as const;
export type Approval = (typeof APPROVALS)[number];

export interface ChangeDeps extends HireDeps {
  signer: LocalAccount; // signs requests: StayWise checks it is the buyer on the booking's job
  ask: (question: string) => Promise<string>; // the human in the loop
  save: (record: TripRecord) => void;
  /** Sandbox demos only: let PriceGuard's SIMULATED savings be paid, to show the flow. */
  demoPaySimulated?: boolean;
}

interface Option {
  total: number;
  currency: string;
  priceDifferencePercent: number;
  checkin: string;
  checkout: string;
}

export interface ChangeState {
  record: TripRecord;
  approvals: Set<Approval>;
  options: Map<string, Option>;
  failures: string[];
  explanation?: Explanation;
}

const yes = (answer: string) => /^\s*(y|yes|haan|ha|ok|sure|go ahead)\b/i.test(answer);

function hotelOf(state: ChangeState) {
  const h = state.record.hires.find((x) => x.skill === "hotels" && x.status === "booked");
  if (!h?.bookingId) throw new Error("This trip has no active hotel booking.");
  return h as typeof h & { bookingId: string };
}

async function readReply(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { error: "non_json_reply", detail: text.slice(0, 200) };
  }
}

/** POST to the agent, signed as the buyer; `paid` lets x402 pay its fee through the mandate. */
async function call(d: ChangeDeps, url: string, payload: unknown, paid = false) {
  const body = JSON.stringify(payload);
  const auth = await signedHeaders(d.signer, "POST", new URL(url).pathname, body);
  const init = { method: "POST", headers: { "content-type": "application/json", ...auth }, body };
  const { response, paid: payment } = paid
    ? await d.payingFetch(url, init)
    : { response: await fetch(url, init), paid: undefined };
  const reply = await readReply(response);
  if (!response.ok) {
    const refund = (reply.refund as { transaction?: string } | undefined)?.transaction;
    throw new Error(
      `HTTP ${response.status} ${reply.error ?? ""} ${reply.detail ?? ""}${refund ? ` — fee refunded: ${refund}` : ""}`,
    );
  }
  return { reply, payment };
}

export function changeTools(state: ChangeState, d: ChangeDeps) {
  const done = (line: string) => {
    state.record.history.push(`${new Date().toISOString().slice(0, 16)} ${line}`);
    d.save(state.record);
    d.log(line);
  };
  const receipt = async (
    job: `0x${string}`,
    payment: {
      requirements: { payTo: string; amount: string };
      settlement: { transaction: string };
    },
  ) =>
    recordReceipt(d.platformWriter, {
      job,
      task: state.record.task,
      mandateId: d.mandateId,
      payer: d.payer,
      payTo: payment.requirements.payTo,
      amountUnits: BigInt(payment.requirements.amount),
      hederaTx: payment.settlement.transaction,
    });

  const view = betaZodTool({
    name: "view_hotel_booking",
    description:
      "See the hotel booking as it stands: dates, price, refund rules and what cancelling right now would cost (cancelFeeNow).",
    inputSchema: z.object({}),
    run: async () => {
      const h = hotelOf(state);
      const { reply } = await call(d, `${h.endpoint}/bookings/${h.bookingId}/view`, {});
      return JSON.stringify(reply);
    },
  });

  const options = betaZodTool({
    name: "get_change_options",
    description:
      "Ask the hotel's agent for locked options at the same hotel with new dates and/or number of adults. Free. Each option shows its total and % vs what was paid.",
    inputSchema: z.object({
      checkin: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      checkout: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      adults: z.number().int().min(1).max(6),
    }),
    run: async (q) => {
      const h = hotelOf(state);
      const { reply } = await call(d, `${h.endpoint}/bookings/${h.bookingId}/change-options`, q);
      for (const o of (reply.options as (Option & { quoteKey: string })[]) ?? [])
        state.options.set(o.quoteKey, o);
      return JSON.stringify(reply);
    },
  });

  const ask = betaZodTool({
    name: "ask_user",
    description:
      "Ask the traveller a yes/no question and wait. Required before anything that costs more than what was paid (about: pay_more) or loses money on a cancellation (about: lose_money). State the exact amount.",
    inputSchema: z.object({ question: z.string().min(5).max(400), about: z.enum(APPROVALS) }),
    run: async ({ question, about }) => {
      const answer = await d.ask(question);
      if (yes(answer)) state.approvals.add(about);
      d.log(`asked traveller: ${question} → "${answer}"`);
      return `Traveller answered: "${answer}" (${yes(answer) ? "approved" : "not approved"})`;
    },
  });

  const confirm = betaZodTool({
    name: "confirm_change",
    description:
      "Irreversible: pay the hotel agent's 0.02 USDC fee and rebook the chosen option. The old booking is cancelled automatically by the hotel system.",
    inputSchema: z.object({ quoteKey: z.string(), reason: z.string().min(5).max(300) }),
    run: async ({ quoteKey, reason }) => {
      const h = hotelOf(state);
      const o = state.options.get(quoteKey);
      if (!o) throw new Error("Unknown option; use a quoteKey from get_change_options.");
      if (o.priceDifferencePercent > 0 && !state.approvals.has("pay_more")) {
        throw new Error(
          `This costs ${o.priceDifferencePercent}% more than what was paid (${o.total} ${o.currency}). ask_user about "pay_more" first.`,
        );
      }
      const { reply, payment } = await call(
        d,
        `${h.endpoint}/bookings/${h.bookingId}/change`,
        { quoteKey },
        true,
      );
      if (!payment) throw new Error("The change was not paid for; nothing changed.");
      const result = reply.result as { queued: boolean; bookingId?: string; status: string };
      if (result.queued) {
        done(`hotel change queued for manual handling (${result.status}): ${reason}`);
        await receipt(h.jobKey, payment);
        return JSON.stringify({ queued: true, status: result.status });
      }
      await setJobStatus(d.buyerWriter, h.jobKey, "changed");
      const job = await openJob(d.buyerWriter, {
        task: state.record.task,
        buyer: d.buyerWriter.account.address,
        seller: h.agent,
        quote: quoteKey as `0x${string}`,
        status: "paid",
        mandateId: d.mandateId,
        description: `hotel change ${o.checkin}→${o.checkout}: ${reason}`.slice(0, 1000),
      });
      await receipt(job.entityKey, payment);
      h.status = "changed";
      state.record.hires.push({
        ...h,
        jobKey: job.entityKey,
        bookingId: result.bookingId,
        status: "booked",
        result,
        quoteNote: `${o.checkin}→${o.checkout} ${o.total} ${o.currency}`,
      });
      done(
        `hotel changed to ${o.checkin}→${o.checkout} (${o.total} ${o.currency}), new booking ${result.bookingId}, fee tx ${payment.settlement.transaction}`,
      );
      return JSON.stringify({
        changed: true,
        newBookingId: result.bookingId,
        option: o,
        hederaTx: payment.settlement.transaction,
      });
    },
  });

  const guest = betaZodTool({
    name: "change_guest",
    description:
      "Pay the hotel agent's 0.01 USDC fee to change the lead guest's name/email on the booking. The hotel processes it, so it may show PENDING.",
    inputSchema: z.object({
      firstName: z.string().min(1),
      lastName: z.string().min(1),
      email: z.email(),
    }),
    run: async (g) => {
      const h = hotelOf(state);
      const { reply, payment } = await call(
        d,
        `${h.endpoint}/bookings/${h.bookingId}/guest`,
        g,
        true,
      );
      if (payment) await receipt(h.jobKey, payment);
      done(`lead guest change to ${g.firstName} ${g.lastName} requested`);
      return JSON.stringify(reply);
    },
  });

  const cancel = betaZodTool({
    name: "cancel_booking",
    description:
      "Cancel the hotel booking. Free with StayWise. If the hotel would keep money (cancelFeeNow > 0), ask_user about lose_money first.",
    inputSchema: z.object({ reason: z.string().min(3).max(300) }),
    run: async ({ reason }) => {
      const h = hotelOf(state);
      const { reply: v } = await call(d, `${h.endpoint}/bookings/${h.bookingId}/view`, {});
      const fee = Number(v.cancelFeeNow ?? 0);
      if (fee > 0 && !state.approvals.has("lose_money")) {
        throw new Error(
          `Cancelling now costs ${fee} (the hotel keeps it). ask_user about "lose_money" first.`,
        );
      }
      const { reply } = await call(d, `${h.endpoint}/bookings/${h.bookingId}/cancel`, {});
      await setJobStatus(d.buyerWriter, h.jobKey, "cancelled");
      h.status = "cancelled";
      const r = reply.result as { status: string; refund: number; fee: number; currency: string };
      done(
        `hotel cancelled (${r.status}): refund ${r.refund} ${r.currency}, fee ${r.fee} — ${reason}`,
      );
      return JSON.stringify(reply);
    },
  });

  const finish = betaZodTool({
    name: "finish",
    description:
      "Call exactly once, last: tell the traveller what changed, what it cost and how the trip stands now — only facts from tool results.",
    inputSchema: ExplanationSchema,
    run: async (explanation) => {
      state.explanation = explanation;
      return "Saved. You are done — do not call any more tools.";
    },
  });

  return { view, options, ask, confirm, guest, cancel, finish };
}
