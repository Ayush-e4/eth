import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { Card, ConciergeEvent } from "@eth/shared";
import { z } from "zod";
import type { HotelGuard } from "../hiring/hotel-guard";
import type { ChatLike } from "../hiring/service";

/** PriceGuard from the chat: watch a hotel booking's price, and pay its fee when the user says. */
export function guardTools(
  guard: HotelGuard,
  user: { id: string },
  chat: ChatLike,
  show: (card: Card) => void,
  emit: (event: ConciergeEvent) => void,
) {
  const guardHotel = betaZodTool({
    name: "guard_hotel_price",
    description:
      "Turn on PriceGuard for one of the user's hotel bookings (see my_bookings): until check-in, if the same stay gets cheaper by at least both limits while it's still free to cancel, it rebooks it for less and asks 20% of the saving, paid only if the user agrees. Free to turn on. Shows a live card.",
    inputSchema: z.object({
      booking: z.string().min(1).max(80).describe("the hotel booking's id or reference"),
      minSavingInr: z.number().min(0).default(500),
      minSavingPercent: z.number().min(0).max(100).default(5),
    }),
    run: async ({ booking, minSavingInr, minSavingPercent }) => {
      emit({ type: "status", label: "Setting up PriceGuard" });
      try {
        const card = await guard.start(user.id, chat.id, booking, {
          minSavingInr,
          minSavingPercent,
        });
        show(card);
        return `PriceGuard is watching it: acts if at least ₹${minSavingInr} and ${minSavingPercent}% cheaper. Its news is posted in this chat.`;
      } catch (err) {
        return `Couldn't: ${String((err as Error).message ?? err).slice(0, 300)}`;
      }
    },
  });

  const payInvoice = betaZodTool({
    name: "pay_invoice",
    description:
      "Pay one of PriceGuard's invoices (its success fee) after the app checks the proof. Only when the user says to pay. May show a limit or approval card: then stop and wait.",
    inputSchema: z.object({ invoice: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }),
    run: async ({ invoice }) => {
      emit({ type: "status", label: "Checking PriceGuard's proof" });
      const out = await guard.pay(user.id, chat, invoice);
      if ("card" in out) show(out.card);
      if (out.status === "hired") return `Paid PriceGuard: ${out.card.summary}.`;
      if (out.status === "needs_limit")
        return "Not paid yet: the fee is above this chat's limit, so a card asks the user to approve a limit just for it. Stop and wait; call pay_invoice again once approved.";
      if (out.status === "needs_approval")
        return `Not paid yet: the user sees an approval card (code ${out.card.code}). Stop and wait.`;
      return out.status === "refused" ? out.reason : "Not paid.";
    },
  });

  return { guardHotel, payInvoice };
}
