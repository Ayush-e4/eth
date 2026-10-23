import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { findListings, invoicesFor, openJob, recordReceipt } from "@eth/arkiv";
import { z } from "zod";
import { signedHeaders, signStatement } from "../auth";
import type { ChangeDeps, ChangeState } from "./change-tools";
import { checkInvoice } from "./invoices";

/** Tools for PriceGuard: turn the watch on (or change its limits), check and pay its invoices. */
export function priceGuardTools(state: ChangeState, d: ChangeDeps) {
  const verified = new Map<string, { units: bigint; agent: `0x${string}`; saving: number }>();
  const hotels = () => state.record.hires.filter((h) => h.skill === "hotels");
  const done = (line: string) => {
    state.record.history.push(`${new Date().toISOString().slice(0, 16)} ${line}`);
    d.save(state.record);
    d.log(line);
  };
  const priceGuardListing = async (agent?: string) => {
    const all = await findListings(d.arkiv, { skill: "priceguard" });
    const l = agent
      ? all.find((x) => x.record.agent.toLowerCase() === agent.toLowerCase())
      : all[0];
    if (!l) throw new Error("No PriceGuard agent is listed on the marketplace.");
    return l.record;
  };

  const watch = betaZodTool({
    name: "watch_price",
    description:
      "Turn on PriceGuard for the hotel booking, or change its limits (call again). If the price drops by at least both limits before free cancellation closes, it rebooks the same stay cheaper and keeps 20% of the saving. The traveller signs these limits; nobody else can change them.",
    inputSchema: z.object({
      minSavingInr: z.number().min(0).default(500),
      minSavingPercent: z.number().min(0).max(100).default(5),
    }),
    run: async ({ minSavingInr, minSavingPercent }) => {
      const h = hotels().find((x) => x.status === "booked" && x.bookingId);
      if (!h?.bookingId) throw new Error("No active hotel booking to watch.");
      const pg = await priceGuardListing();
      const slip = await signStatement(d.signer, "reprice-delegation", {
        bookingId: h.bookingId,
        agent: h.agent,
        delegate: pg.agent,
        minSavingInr,
        minSavingPercent,
        until: state.record.trip.departDate,
        issuedAt: Date.now(),
      });
      const body = JSON.stringify({
        task: state.record.task,
        bookingId: h.bookingId,
        stayEndpoint: h.endpoint,
        stayAgent: h.agent,
        delegation: slip,
      });
      const res = await fetch(`${pg.endpoint}/watch`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await signedHeaders(d.signer, "POST", "/watch", body)),
        },
        body,
      });
      const reply = await res.text();
      if (!res.ok) throw new Error(`PriceGuard refused: HTTP ${res.status} ${reply.slice(0, 200)}`);
      state.record.priceWatch = {
        agent: pg.agent,
        endpoint: pg.endpoint,
        minSavingInr,
        minSavingPercent,
      };
      done(
        `PriceGuard watching ${h.bookingId}: act if ≥ ₹${minSavingInr} and ≥ ${minSavingPercent}% cheaper, until ${state.record.trip.departDate}`,
      );
      return reply;
    },
  });

  const review = betaZodTool({
    name: "review_invoices",
    description:
      "Find PriceGuard's invoices for this trip and check each one's proof (signed by the hotel's agent, real saving, fee = 20%). Verified rebooks are applied to the trip record.",
    inputSchema: z.object({}),
    run: async () => {
      const paid = new Set(state.record.paidInvoices ?? []);
      const mine = (await invoicesFor(d.arkiv, d.signer.address)).filter(
        (i) => i.record.task === state.record.task && !paid.has(i.key),
      );
      const hotelAgent = hotels()[0]?.agent ?? "";
      const out = [];
      for (const inv of mine) {
        const check = await checkInvoice(inv, {
          hotelAgent,
          tripBookings: hotels().flatMap((h) => (h.bookingId ? [h.bookingId] : [])),
          inrPerUsdc: d.inrRates.USDC ?? 0,
          allowSimulated: d.demoPaySimulated,
        });
        if (check.ok)
          verified.set(inv.key, {
            units: check.units,
            agent: inv.record.agent,
            saving: check.proof.saving,
          });
        // The rebook is a fact once StayWise's signed proof checks out — whether or not a fee is owed.
        const proof = check.proof;
        if (proof) {
          const old = hotels().find(
            (h) => h.bookingId === proof.oldBookingId && h.status === "booked",
          );
          if (old) {
            old.status = "changed";
            state.record.hires.push({
              ...old,
              bookingId: proof.newBookingId,
              status: "booked",
              quoteNote: `PriceGuard rebooked: ${proof.newTotal} ${proof.currency} (compared with ${proof.comparedTotal})${proof.simulated ? " [SIMULATED]" : ""}`,
            });
            done(
              `PriceGuard rebooked ${proof.oldBookingId} → ${proof.newBookingId}${proof.simulated ? " (SIMULATED saving, no fee owed)" : `, saved ${proof.saving} ${proof.currency}`}`,
            );
          }
        }
        out.push({
          invoiceKey: inv.key,
          amountUsdc: Number(inv.record.amountUnits) / 1e6,
          note: inv.record.note,
          verified: check.ok,
          reason: check.ok ? undefined : check.reason,
          proof: check.ok ? check.proof : undefined,
        });
      }
      return JSON.stringify({ invoices: out });
    },
  });

  const pay = betaZodTool({
    name: "pay_invoice",
    description:
      "Pay a PriceGuard invoice that review_invoices verified (its 20% success fee, from the traveller's mandate).",
    inputSchema: z.object({ invoiceKey: z.string() }),
    run: async ({ invoiceKey }) => {
      const v = verified.get(invoiceKey);
      if (!v) throw new Error("Only invoices verified by review_invoices can be paid.");
      const pg = await priceGuardListing(v.agent);
      const { response, paid } = await d.payingFetch(`${pg.endpoint}/invoices/${invoiceKey}/pay`, {
        method: "POST",
      });
      if (!response.ok || !paid)
        throw new Error(
          `Payment failed: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`,
        );
      const job = await openJob(d.buyerWriter, {
        task: state.record.task,
        buyer: d.buyerWriter.account.address,
        seller: v.agent,
        quote: invoiceKey as `0x${string}`,
        status: "paid",
        mandateId: d.mandateId,
        description: `PriceGuard success fee: saved ${v.saving}`,
      });
      await recordReceipt(d.platformWriter, {
        job: job.entityKey,
        task: state.record.task,
        mandateId: d.mandateId,
        payer: d.payer,
        payTo: paid.requirements.payTo,
        amountUnits: v.units,
        hederaTx: paid.settlement.transaction,
      });
      state.record.paidInvoices = [...(state.record.paidInvoices ?? []), invoiceKey];
      verified.delete(invoiceKey);
      done(
        `paid PriceGuard ${Number(v.units) / 1e6} USDC for saving ${v.saving} — tx ${paid.settlement.transaction}`,
      );
      return JSON.stringify({ paid: true, hederaTx: paid.settlement.transaction });
    },
  });

  return { watch, review, pay };
}
