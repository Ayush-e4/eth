import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { Card, ConciergeEvent } from "@eth/shared";
import { z } from "zod";
import type { BookingDesk } from "../hiring/bookings";

const which = z.string().min(1).max(80).describe("the booking's id or its booking reference");

/**
 * The user's bookings, from any chat: what they booked through agents, and changing or
 * cancelling it. Changes are paid with hire_agent like any job; cancels need the user's approval.
 */
export function bookingTools(
  desk: BookingDesk,
  user: { id: string },
  chat: { id: string },
  show: (card: Card) => void,
  emit: (event: ConciergeEvent) => void,
) {
  const myBookings = betaZodTool({
    name: "my_bookings",
    description:
      "List the flights the user booked through agents (from any chat), newest first, with booking references. Use it when they talk about a booking they already have.",
    inputSchema: z.object({}),
    run: async () => {
      const all = await desk.list(user.id);
      return all.length
        ? JSON.stringify(
            all.map((b) => ({
              id: b.id,
              bookingReference: b.bookingReference,
              agent: b.agentTitle,
              bookedAt: b.bookedAt.slice(0, 10),
              inChat: b.chatTitle,
              ...(b.changes ? { changedTimes: b.changes } : {}),
            })),
          )
        : "No flights booked through agents yet.";
    },
  });

  const manageBooking = betaZodTool({
    name: "manage_booking",
    description: `Look at, change or cancel one of the user's flight bookings (see my_bookings).
- "view": the booking as the airline has it now (flights, whether it can change or cancel).
- "change_options": ways to move a flight to \`date\` (outbound unless flight="return"). Shows a
  quotes card and returns refs (q1…): to make the change, call hire_agent with the ref the user
  picks. Changes usually cost more at the airline: the app then asks the user to approve.
- "cancel": the app shows the refund on an approval card first; call again once approved.`,
    inputSchema: z.object({
      booking: which,
      action: z.enum(["view", "change_options", "cancel"]),
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("new date, for change_options"),
      flight: z.enum(["outbound", "return"]).optional(),
    }),
    run: async ({ booking, action, date, flight }) => {
      try {
        if (action === "view") {
          emit({ type: "status", label: "Looking up the booking" });
          return JSON.stringify(await desk.view(user.id, booking));
        }
        if (action === "change_options") {
          if (!date) return "Say which date to move it to (date: YYYY-MM-DD).";
          emit({ type: "status", label: "Asking the airline for other flights" });
          const out = await desk.changeOptions(user.id, chat.id, booking, { date, flight });
          if (!out.held.length) return `No flights to move to on ${date}.`;
          show({
            type: "quotes",
            skill: "flights.change",
            reason: `Moving ${out.current} (booking ${out.booking.bookingReference}); cheapest change first`,
            quotes: out.held.map(({ ref, option: o }) => ({
              key: ref,
              title: o.title.split(" — ")[0] ?? o.title,
              note: o.note,
              feeUnits: o.feeUnits.toString(),
              itemTotal: o.itemTotal,
              itemCurrency: o.itemCurrency,
              reply: `Move it to this flight (${ref})`,
            })),
          });
          return JSON.stringify({
            moving: out.current,
            options: out.held.map(({ ref, option: o }) => ({
              ref,
              flight: o.note,
              agentFeeUsdc: (Number(o.feeUnits) / 1e6).toFixed(2),
            })),
            next: "To change, call hire_agent with the ref the user picks. Airline amounts are as given; don't convert them.",
          });
        }
        const out = await desk.cancel(user.id, chat.id, booking);
        if (out.status === "cancelled")
          return `Cancelled. ${out.refund} ${out.currency} comes back (test mode).`;
        show(out.card);
        return out.card.human
          ? `Not cancelled yet: the user must approve on the card (code ${out.card.code}) with a World ID check. Stop and wait.`
          : `Not cancelled yet: the card shows the refund. Stop and wait for "Approve ${out.card.code}", then call manage_booking cancel again.`;
      } catch (err) {
        return `Couldn't: ${String((err as Error).message ?? err).slice(0, 300)}`;
      }
    },
  });

  return { myBookings, manageBooking };
}
