import type { TripRecord } from "../trips";
import { type ChangeDeps, type ChangeState, changeTools } from "./change-tools";
import { anthropic, MODEL } from "./claude";
import type { Explanation } from "./explain";

const SYSTEM = `You manage a trip that is already booked, for the traveller who booked it. Hotel changes go
through the agent that booked the hotel (StayWise); you pay its small fees from the traveller's mandate.
- To see the booking: view_hotel_booking.
- To change dates or the number of guests: get_change_options (adults = the trip's number of travellers
  unless the traveller asks to change it; sandbox bookings may show 1 adult), pick the cheapest option
  that does what the traveller asked, then confirm_change. If it costs more than what was paid, first ask_user (about
  "pay_more") with the exact new total and difference; continue only if they say yes.
- To change the lead guest's name: change_guest (0.01 USDC; the hotel processes it, so it may be PENDING).
- To cancel: view_hotel_booking first. If cancelling now costs anything (cancelFeeNow > 0 or the rate is
  non-refundable), ask_user (about "lose_money") with the amount; continue only on yes. A free
  cancellation needs no question.
- Flights can't be changed or cancelled yet: say so if asked.
- Call finish exactly once, last: headline; itinerary = the trip as it stands now; spends = the fees paid
  now (change 0.02 USDC, guest 0.01 USDC; cancelling is free); caveats = sandbox bookings, anything
  pending, refused or not possible.
Never invent prices, dates or references.`;

export interface ChangeRun {
  record: TripRecord;
  explanation?: Explanation;
  failures: string[];
}

/** A follow-up conversation about a saved trip: Claude changes or cancels through the agents. */
export async function runChangeAgent(
  request: string,
  record: TripRecord,
  d: ChangeDeps,
): Promise<ChangeRun> {
  const state: ChangeState = { record, approvals: new Set(), options: new Map(), failures: [] };
  const t = changeTools(state, d);
  const runner = anthropic().beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 16000,
    max_iterations: 14,
    output_config: { effort: "medium" },
    tools: [t.view, t.options, t.ask, t.confirm, t.guest, t.cancel, t.finish],
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: `Traveller: ${request}\n\nTheir trip: ${JSON.stringify(summary(record))}`,
      },
    ],
  });
  for await (const message of runner) {
    for (const block of message.content) {
      if (block.type === "tool_use" && block.name !== "finish") {
        d.log(`claude → ${block.name} ${JSON.stringify(block.input).slice(0, 160)}`);
      }
    }
  }
  const final = await runner.done();
  if (final.stop_reason === "refusal") state.failures.push("Claude declined to continue");
  return { record: state.record, explanation: state.explanation, failures: state.failures };
}

/** What Claude needs to know about the trip — without bulky booking payloads. */
function summary(r: TripRecord) {
  return {
    trip: r.trip,
    bookings: r.hires.map((h) => ({
      skill: h.skill,
      agent: h.agentTitle,
      status: h.status,
      bookingId: h.bookingId,
      booked: h.quoteNote,
    })),
    history: r.history,
  };
}
