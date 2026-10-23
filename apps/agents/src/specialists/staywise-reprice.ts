import { randomUUID } from "node:crypto";
import { cancellationFeeAt, type LiteApiClient } from "@eth/travel";
import type { Context, Hono, Next } from "hono";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { type RepriceDelegation, type Signed, signStatement, verifyStatement } from "../auth";
import { demoTraveller } from "../trip";
import type { SpecialistKit } from "./server";
import { type BookingRecord, bookingOwner, type ManageDeps, signerOf } from "./staywise-manage";

const OPTION_TTL_MS = 3 * 60_000;
const cents = (n: number) => Math.round(n * 100) / 100;

export interface RepriceDeps extends ManageDeps {
  lite: LiteApiClient;
  /** Sandbox demos only: pretend the booking cost this % more, so a "drop" can be shown. */
  simulateDropPercent?: number;
}

/** What StayWise signs after a cheaper rebook — the proof a watcher's invoice relies on. */
export interface RepriceAttestation {
  kind: "reprice";
  oldBookingId: string;
  newBookingId: string;
  hotelName?: string;
  checkin: string;
  checkout: string;
  paidTotal: number; // what the old booking really cost
  comparedTotal: number; // what the saving is measured against (= paidTotal unless SIMULATED)
  newTotal: number;
  currency: string;
  cancelFee: number;
  refund: number;
  saving: number;
  simulated: boolean;
  at: string;
}

const SignedDelegation = z.object({
  body: z.object({
    bookingId: z.string(),
    agent: z.string(),
    delegate: z.string(),
    minSavingInr: z.number().min(0),
    minSavingPercent: z.number().min(0),
    until: z.string(),
    issuedAt: z.number(),
  }),
  signer: z.string(),
  signature: z.string(),
}) as unknown as z.ZodType<Signed<RepriceDelegation>>;

/**
 * Price watching for StayWise's bookings, used by a watcher agent (PriceGuard) the owner allowed:
 *   POST /bookings/:id/delegate         register the owner's signed permission slip
 *   POST /bookings/:id/reprice-options  free — best refundable price now for the same stay, locked
 *   POST /bookings/:id/reprice          book the cheaper rate, THEN cancel the old one; signed proof
 * StayWise enforces the owner's limits (minimum saving, deadline) itself.
 */
export function repriceRoutes(deps: RepriceDeps) {
  const now = deps.now ?? (() => new Date());
  return (app: Hono, kit: SpecialistKit) => {
    const me = kit.ctx.identity.evm;
    const stay = privateKeyToAccount(kit.ctx.identity.key);
    const ownerOf = bookingOwner(deps, me);
    const options = new Map<
      string,
      {
        bookingId: string;
        prebookId: string;
        newTotal: number;
        currency: string;
        expiresAt: number;
      }
    >();
    const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

    /** The watcher's request: signed by it, with a live slip from the booking's owner. */
    const delegateGuard = async (c: Context, next: Next) => {
      const rec = deps.store.get(c.req.param("id") ?? "");
      if (!rec) return c.json({ error: "unknown_booking" }, 404);
      if (rec.replacedBy)
        return c.json({ error: "booking_replaced", replacedBy: rec.replacedBy }, 409);
      const signer = await signerOf(c);
      if (!signer) return c.json({ error: "unauthorized" }, 401);
      const slip = rec.delegations?.find((d) => same(d.body.delegate, signer));
      if (!slip || slip.body.until < now().toISOString().slice(0, 10)) {
        return c.json({ error: "no_live_delegation" }, 403);
      }
      c.set("booking" as never, rec as never);
      c.set("slip" as never, slip as never);
      await next();
    };
    const record = (c: Context) => c.get("booking" as never) as BookingRecord;
    const slipOf = (c: Context) => c.get("slip" as never) as Signed<RepriceDelegation>;

    app.post("/bookings/:id/delegate", async (c) => {
      const rec = deps.store.get(c.req.param("id") ?? "");
      if (!rec) return c.json({ error: "unknown_booking" }, 404);
      const signer = await signerOf(c);
      const slip = SignedDelegation.parse((await c.req.json()).delegation);
      const owner = await ownerOf(rec);
      const valid =
        (await verifyStatement("reprice-delegation", slip)) &&
        same(slip.signer, owner) &&
        same(slip.body.agent, me) &&
        same(slip.body.delegate, signer) &&
        slip.body.bookingId === rec.bookingId;
      if (!valid) return c.json({ error: "invalid_delegation" }, 403);
      const others = (rec.delegations ?? []).filter((d) => !same(d.body.delegate, signer));
      deps.store.set(rec.bookingId, { ...rec, delegations: [...others, slip] });
      return c.json({ registered: true, limits: slip.body });
    });

    app.post("/bookings/:id/reprice-options", delegateGuard, async (c) => {
      const rec = record(c);
      const b = await deps.bookings.get(rec.bookingId);
      if (b.status !== "CONFIRMED" || !rec.hotelId || b.total === undefined) {
        return c.json({ error: "not_repriceable", status: b.status }, 409);
      }
      const simulated = !!deps.simulateDropPercent;
      const compared = cents(b.total * (1 + (deps.simulateDropPercent ?? 0) / 100));
      const offers = await deps.lite.searchHotels({
        hotelIds: [rec.hotelId],
        checkin: b.checkin,
        checkout: b.checkout,
        adults: rec.adults ?? b.adults ?? 1,
        refundableOnly: true,
      });
      const best = offers[0];
      if (!best) return c.json({ current: b, option: null, saving: 0, simulated });
      const locked = await deps.lite.prebook(best.offerId);
      const optionKey = randomUUID();
      options.set(optionKey, {
        bookingId: rec.bookingId,
        prebookId: locked.prebookId,
        newTotal: locked.total,
        currency: locked.currency,
        expiresAt: Date.now() + OPTION_TTL_MS,
      });
      const saving = Math.round((compared - locked.total) * 100) / 100;
      return c.json({
        current: {
          bookingId: b.bookingId,
          hotelName: b.hotelName,
          paidTotal: b.total,
          comparedTotal: compared,
          currency: b.currency,
          refundable: b.refundable,
          cancelFeeNow: cancellationFeeAt(b, now()),
        },
        option: {
          optionKey,
          total: locked.total,
          currency: locked.currency,
          roomName: best.roomName,
          refundable: locked.refundable,
        },
        saving,
        savingPercent: Math.round((saving / compared) * 1000) / 10,
        simulated,
      });
    });

    app.post("/bookings/:id/reprice", delegateGuard, async (c) => {
      const rec = record(c);
      const limits = slipOf(c).body;
      const { optionKey } = z.object({ optionKey: z.string() }).parse(await c.req.json());
      const o = options.get(optionKey);
      if (!o || o.bookingId !== rec.bookingId || o.expiresAt < Date.now())
        return c.json({ error: "unknown_or_expired_option" }, 409);
      const old = await deps.bookings.get(rec.bookingId);
      const paid = old.total ?? 0;
      const compared = cents(paid * (1 + (deps.simulateDropPercent ?? 0) / 100));
      const saving = Math.round((compared - o.newTotal) * 100) / 100;
      // The owner's limits, enforced here: the watcher can't go below them.
      if (saving < limits.minSavingInr || (saving / compared) * 100 < limits.minSavingPercent) {
        return c.json({ error: "below_owner_limits", saving, limits }, 409);
      }
      if (old.refundable === false || cancellationFeeAt(old, now()) > 0) {
        return c.json({ error: "cancelling_would_cost_money" }, 409);
      }
      options.delete(optionKey);
      const lead = demoTraveller(0);
      const guest = {
        firstName: old.holder?.firstName || lead.givenName,
        lastName: old.holder?.lastName || lead.familyName,
        email: old.holder?.email || lead.email,
        phone: `+${lead.phoneCountryCode}${lead.phone}`,
      };
      // Book the cheaper one FIRST (unique reference: LiteAPI refuses a reused one).
      let fresh: Awaited<ReturnType<typeof deps.lite.book>>;
      try {
        fresh = await deps.lite.book(
          o.prebookId,
          guest,
          `${rec.task}-pg-${Date.now().toString(36)}`,
        );
      } catch (err) {
        return c.json(
          { error: "rebook_failed_nothing_changed", detail: String(err).slice(0, 300) },
          502,
        );
      }
      let cancelled: Awaited<ReturnType<typeof deps.bookings.cancel>>;
      try {
        cancelled = await deps.bookings.cancel(rec.bookingId);
      } catch (err) {
        await deps.bookings.cancel(fresh.bookingId).catch(() => undefined); // never leave two rooms
        return c.json(
          { error: "cancel_failed_rolled_back", detail: String(err).slice(0, 300) },
          502,
        );
      }
      deps.store.set(fresh.bookingId, {
        ...rec,
        bookingId: fresh.bookingId,
        replacedBy: undefined,
      });
      deps.store.set(rec.bookingId, { ...rec, replacedBy: fresh.bookingId });
      const attestation: RepriceAttestation = {
        kind: "reprice",
        oldBookingId: rec.bookingId,
        newBookingId: fresh.bookingId,
        hotelName: old.hotelName,
        checkin: old.checkin,
        checkout: old.checkout,
        paidTotal: paid,
        comparedTotal: compared,
        newTotal: o.newTotal,
        currency: o.currency,
        cancelFee: cancelled.fee,
        refund: cancelled.refund,
        saving,
        simulated: !!deps.simulateDropPercent,
        at: now().toISOString(),
      };
      return c.json({ proof: await signStatement(stay, "attestation", attestation) });
    });
  };
}
