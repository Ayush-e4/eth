import { type ArkivReader, jobsForTask, postQuote } from "@eth/arkiv";
import { type ChangeOption, cancellationFeeAt, type LiteHotelBookings } from "@eth/travel";
import type { Context, Hono, Next } from "hono";
import { z } from "zod";
import { type RepriceDelegation, type Signed, verifySigned } from "../auth";
import type { JsonStore } from "../store";
import { demoTraveller } from "../trip";
import type { SpecialistKit } from "./server";

export const CHANGE_FEE = 20_000n; // 0.02 USDC to change dates / number of guests
export const GUEST_FEE = 10_000n; // 0.01 USDC to change the lead guest's name
const OPTION_TTL_SECONDS = 180;

/** What StayWise remembers about each booking it made — its own records. */
export interface BookingRecord {
  bookingId: string;
  task: string;
  quoteKey: string; // the quote the buyer paid for; its Arkiv job names the buyer
  owner?: `0x${string}`; // the buyer, once confirmed from Arkiv (or inherited on a change)
  replacedBy?: string; // set when a change or a cheaper rebook replaced this booking
  hotelId?: string; // to search the same hotel again (price watching)
  adults?: number;
  delegations?: Signed<RepriceDelegation>[]; // watchers the owner allowed to reprice this booking
}

/** What any agent keeps to know who may manage a booking. */
type Owned = { bookingId: string; task: string; quoteKey: string; owner?: `0x${string}` };

/** Who owns a booking: the buyer on its Arkiv job (cached once found, inherited on changes). */
export function bookingOwner<R extends Owned>(
  deps: { store: JsonStore<R>; arkiv: ArkivReader },
  me: string,
) {
  return async (rec: R): Promise<`0x${string}` | undefined> => {
    if (rec.owner) return rec.owner;
    const jobs = await jobsForTask(deps.arkiv, rec.task);
    const job = jobs.find(
      (j) => j.record.seller.toLowerCase() === me.toLowerCase() && j.record.quote === rec.quoteKey,
    );
    if (job) deps.store.set(rec.bookingId, { ...rec, owner: job.record.buyer });
    return job?.record.buyer;
  };
}

/** The address that signed this request, or undefined if unsigned/stale/forged. */
export async function signerOf(c: Context): Promise<`0x${string}` | undefined> {
  return verifySigned((n) => c.req.header(n), c.req.method, c.req.path, await c.req.text()).catch(
    () => undefined,
  );
}

export interface ManageDeps {
  bookings: LiteHotelBookings;
  store: JsonStore<BookingRecord>;
  arkiv: ArkivReader;
  now?: () => Date;
}

const ChangeBody = z.object({
  checkin: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  checkout: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  adults: z.number().int().min(1).max(6),
});
const ConfirmBody = z.object({ quoteKey: z.string() });
const GuestBody = z.object({
  firstName: z.string().min(1).max(60),
  lastName: z.string().min(1).max(60),
  email: z.email(),
});

/**
 * Booking management for StayWise, mounted next to /quote and /work:
 *   POST /bookings/:id/view            free  — details, refund rules, cost of cancelling now
 *   POST /bookings/:id/change-options  free  — locked options for new dates/guests (Arkiv quotes)
 *   POST /bookings/:id/change          0.02  — rebook the chosen option (old booking auto-cancelled)
 *   POST /bookings/:id/guest           0.01  — change the lead guest's name
 *   POST /bookings/:id/cancel          free  — cancel
 * Every request must be signed by the buyer of the booking's Arkiv job — checked before paying.
 */
export function manageRoutes(deps: ManageDeps) {
  const now = deps.now ?? (() => new Date());
  return (app: Hono, kit: SpecialistKit) => {
    const me = kit.ctx.identity.evm.toLowerCase();
    const options = new Map<
      string,
      { bookingId: string; option: ChangeOption; expiresAt: number }
    >();
    const record = (c: Context) => c.get("booking" as never) as BookingRecord;

    const ownerOf = bookingOwner(deps, me);

    const guard = async (c: Context, next: Next) => {
      const rec = deps.store.get(c.req.param("id") ?? "");
      if (!rec) return c.json({ error: "unknown_booking" }, 404);
      if (rec.replacedBy)
        return c.json({ error: "booking_replaced", replacedBy: rec.replacedBy }, 409);
      const signer = await signerOf(c);
      if (!signer) return c.json({ error: "unauthorized" }, 401);
      const buyer = await ownerOf(rec);
      if (!buyer || buyer.toLowerCase() !== signer.toLowerCase()) {
        return c.json({ error: "not_your_booking" }, 403);
      }
      c.set("booking" as never, rec as never);
      await next();
    };

    app.post("/bookings/:id/view", guard, async (c) => {
      const b = await deps.bookings.get(record(c).bookingId);
      return c.json({ booking: b, cancelFeeNow: cancellationFeeAt(b, now()) });
    });

    app.post("/bookings/:id/change-options", guard, async (c) => {
      const rec = record(c);
      const q = ChangeBody.parse(await c.req.json());
      const current = await deps.bookings.get(rec.bookingId);
      const found = await deps.bookings.changeOptions(rec.bookingId, q);
      const listed = [];
      for (const option of found) {
        const note = `${current.hotelName ?? "Hotel"} ${option.checkin}→${option.checkout}, ${q.adults} adult(s): ${option.total.toLocaleString("en-IN")} ${option.currency} (${option.priceDifferencePercent >= 0 ? "+" : ""}${option.priceDifferencePercent}% vs paid)`;
        const { entityKey } = await postQuote(
          kit.writer,
          {
            agent: kit.ctx.identity.evm,
            task: rec.task,
            skill: "hotels.change",
            priceUnits: CHANGE_FEE,
            note,
            itemTotal: option.total,
            itemCurrency: option.currency,
          },
          OPTION_TTL_SECONDS,
        );
        options.set(entityKey, {
          bookingId: rec.bookingId,
          option,
          expiresAt: Date.now() + OPTION_TTL_SECONDS * 1000,
        });
        listed.push({ quoteKey: entityKey, note, ...option });
      }
      return c.json({ current, options: listed, changeFeeUsdc: Number(CHANGE_FEE) / 1e6 });
    });

    app.post(
      "/bookings/:id/change",
      guard,
      async (c, next) => {
        // Check the option BEFORE the paywall: nobody pays for an option we can't honour.
        const { quoteKey } = ConfirmBody.parse(await c.req.json());
        const o = options.get(quoteKey);
        if (!o || o.bookingId !== record(c).bookingId || o.expiresAt < Date.now()) {
          return c.json({ error: "unknown_or_expired_option" }, 409);
        }
        await next();
      },
      kit.feeWall(CHANGE_FEE, "StayWise — change hotel dates/guests"),
      async (c) => {
        const rec = record(c);
        const { quoteKey } = ConfirmBody.parse(await c.req.json());
        const o = options.get(quoteKey);
        if (!o) return c.json({ error: "unknown_or_expired_option" }, 409);
        options.delete(quoteKey);
        try {
          const before = await deps.bookings.get(rec.bookingId);
          const lead = demoTraveller(0);
          const result = await deps.bookings.rebook(o.option.prebookId, rec.bookingId, {
            firstName: before.holder?.firstName || lead.givenName,
            lastName: before.holder?.lastName || lead.familyName,
            email: before.holder?.email || lead.email,
          });
          if (!result.queued) {
            deps.store.set(result.bookingId, {
              bookingId: result.bookingId,
              task: rec.task,
              quoteKey,
              owner: rec.owner,
            });
            deps.store.set(rec.bookingId, { ...rec, replacedBy: result.bookingId });
          }
          return c.json({ agent: "StayWise", result, option: o.option });
        } catch (err) {
          const refund = await kit.refundPaid(c, CHANGE_FEE, `refund change ${rec.bookingId}`);
          return c.json({ error: "change_failed", detail: String(err).slice(0, 400), refund }, 502);
        }
      },
    );

    app.post(
      "/bookings/:id/guest",
      guard,
      kit.feeWall(GUEST_FEE, "StayWise — change lead guest"),
      async (c) => {
        const rec = record(c);
        try {
          const result = await deps.bookings.amendHolder(
            rec.bookingId,
            GuestBody.parse(await c.req.json()),
          );
          return c.json({ agent: "StayWise", result });
        } catch (err) {
          const refund = await kit.refundPaid(c, GUEST_FEE, `refund guest ${rec.bookingId}`);
          return c.json(
            { error: "guest_change_failed", detail: String(err).slice(0, 400), refund },
            502,
          );
        }
      },
    );

    app.post("/bookings/:id/cancel", guard, async (c) => {
      const result = await deps.bookings.cancel(record(c).bookingId);
      return c.json({ agent: "StayWise", result });
    });
  };
}
