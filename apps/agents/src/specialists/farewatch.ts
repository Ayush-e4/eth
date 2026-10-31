import type { ArkivReader } from "@eth/arkiv";
import type { LiteFlightOffer } from "@eth/travel";
import type { Context, Hono, Next } from "hono";
import { z } from "zod";
import type { JsonStore } from "../store";
import { describeItinerary } from "./flight-note";
import type { SpecialistDef, SpecialistKit } from "./server";
import { bookingOwner, signerOf } from "./staywise-manage";

const iata = z.string().regex(/^[A-Z]{3}$/, "airport code, e.g. BOM");
export const WatchInput = z.object({
  origin: iata.describe("from, e.g. BOM"),
  destination: iata.describe("to, e.g. GOI"),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe("flight date"),
  adults: z.number().int().min(1).max(6).default(1),
  targetInr: z
    .number()
    .positive()
    .optional()
    .describe("tell me when the whole fare is at or below this (INR)"),
  autoBook: z
    .boolean()
    .default(false)
    .describe("book it when it reaches targetInr (only in chats that pay by themselves)"),
  hours: z.number().int().min(1).max(336).default(72).describe("how long to watch"),
});
export type WatchRequest = z.infer<typeof WatchInput>;

export interface FareCheck {
  at: string;
  price: number; // INR, whole fare
  flight: string;
  simulated?: boolean; // sandbox demo: a made-up drop, never a real price
}
export interface FareAlert extends FareCheck {
  was: number;
  reason: string;
}
export interface Watch {
  bookingId: string; // the watch id (its quote key), named so the owner check fits
  task: string;
  quoteKey: string;
  owner?: `0x${string}`;
  input: WatchRequest;
  until: string;
  baseline: FareCheck;
  lowest: FareCheck;
  checks: FareCheck[]; // the latest ones
  alerts: FareAlert[];
  status: "watching" | "ended" | "stopped";
  simulateNext?: number; // percent off the next check (sandbox demos only)
}

export interface FareWatchDeps {
  search(q: {
    origin: string;
    destination: string;
    date: string;
    adults: number;
  }): Promise<LiteFlightOffer[]>;
  store: JsonStore<Watch>;
  arkiv: ArkivReader;
  everyMs?: number; // how often each watch is checked (default 15 min)
  simulate?: boolean; // allow made-up drops for demos (sandbox only, always labelled)
  now?: () => number;
}

const FEE = 20_000n; // 0.02 USDC per watch
const KEEP = 50; // checks kept per watch
const DROP = 0.03; // without a target: tell when it's 3% under the lowest seen so far
const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

/**
 * FareWatch: watches a flight route and date for a while and tells its buyer when the fare
 * drops (or reaches the buyer's target). It checks LiteAPI flights on a schedule and keeps every
 * check; the buyer (who signed /work) reads the watch with signed requests. It never books: the
 * buyer's concierge decides that. Web2 analogy: a price alert on a travel site. Fee: 0.02 USDC.
 */
export function farewatch(d: FareWatchDeps): SpecialistDef<WatchRequest, FareCheck, unknown> {
  const now = d.now ?? Date.now;
  const cheapest = async (w: WatchRequest): Promise<FareCheck> => {
    const [best] = await d.search({ ...w, adults: w.adults });
    if (!best) throw new Error(`No flights ${w.origin}→${w.destination} on ${w.date}`);
    if (best.currency !== "INR") throw new Error(`fares came in ${best.currency}, not INR`);
    return {
      at: new Date(now()).toISOString(),
      price: best.total,
      flight: describeItinerary(best, inr(best.total)),
    };
  };

  /** One check of one watch: record it, and alert on a drop or a reached target. */
  async function check(w: Watch): Promise<Watch> {
    if (w.status !== "watching") return w;
    if (now() > Date.parse(w.until)) return save({ ...w, status: "ended" });
    let c = await cheapest(w.input);
    if (w.simulateNext) {
      const price = Math.round(c.price * (1 - w.simulateNext / 100));
      c = { ...c, price, flight: c.flight.replace(inr(c.price), inr(price)), simulated: true };
      w = { ...w, simulateNext: undefined };
    }
    const target = w.input.targetInr;
    const reason =
      target !== undefined
        ? c.price <= target && !w.alerts.some((a) => a.price <= c.price)
          ? `at or below your target of ${inr(target)}`
          : null
        : c.price <= w.lowest.price * (1 - DROP)
          ? `${Math.round((1 - c.price / w.lowest.price) * 100)}% under the lowest so far`
          : null;
    const alerts = reason ? [...w.alerts, { ...c, was: w.lowest.price, reason }] : w.alerts;
    return save({
      ...w,
      checks: [...w.checks, c].slice(-KEEP),
      lowest: c.price < w.lowest.price ? c : w.lowest,
      alerts,
    });
  }
  const save = (w: Watch) => {
    d.store.set(w.bookingId, w);
    return w;
  };

  async function checkAll(log: (l: string) => void) {
    for (const w of d.store.values().filter((x) => x.status === "watching"))
      await check(w).catch((err) => log(`FareWatch: check failed: ${String(err).slice(0, 120)}`));
  }

  const routes = (app: Hono, kit: SpecialistKit) => {
    const ownerOf = bookingOwner(d, kit.ctx.identity.evm);
    const lastManual = new Map<string, number>();
    const guard = async (c: Context, next: Next) => {
      const w = d.store.get(c.req.param("id") ?? "");
      if (!w) return c.json({ error: "unknown_watch" }, 404);
      const signer = await signerOf(c);
      const owner = signer && (await ownerOf(w));
      if (!owner || owner.toLowerCase() !== signer?.toLowerCase())
        return c.json({ error: "not_your_watch" }, 403);
      c.set("watch" as never, w as never);
      await next();
    };
    const watch = (c: Context) => c.get("watch" as never) as Watch;

    app.post("/watches/:id/view", guard, (c) => c.json({ watch: watch(c) }));
    app.post("/watches/:id/stop", guard, (c) =>
      c.json({ watch: save({ ...watch(c), status: "stopped" }) }),
    );
    // "Check now", at most once a minute per watch.
    app.post("/watches/:id/check-now", guard, async (c) => {
      const w = watch(c);
      if (now() - (lastManual.get(w.bookingId) ?? 0) < 60_000)
        return c.json({ error: "checked_a_moment_ago" }, 429);
      lastManual.set(w.bookingId, now());
      return c.json({ watch: await check(w) });
    });
    // Sandbox demos: make the next check come in lower. Always labelled SIMULATED.
    if (d.simulate)
      app.post("/watches/:id/simulate", guard, async (c) => {
        const { percent } = z
          .object({ percent: z.number().min(1).max(50) })
          .parse(await c.req.json());
        return c.json({ watch: await check({ ...watch(c), simulateNext: percent }) });
      });

    const t = setInterval(() => void checkAll(kit.ctx.log ?? (() => {})), d.everyMs ?? 900_000);
    t.unref?.();
  };

  return {
    name: "FareWatch",
    skill: "farewatch",
    title: "FareWatch — tells you when a flight gets cheaper",
    description:
      "Watches a route and date and alerts you when the fare drops or reaches your target (LiteAPI flights, sandbox).",
    input: WatchInput,
    priceUnits: FEE,
    async quote({ input: w }) {
      const c = await cheapest(w);
      const goal = w.targetInr
        ? `, tell you at ${inr(w.targetInr)} or less`
        : ", tell you on a drop";
      return {
        note: `Watch ${w.origin}→${w.destination} on ${w.date} for ${w.hours}h (now ${c.flight})${goal}`,
        detail: c,
        itemTotal: 0, // nothing is bought: the fee is the whole cost
        itemCurrency: "INR",
      };
    },
    async work({ task, quoteKey, input }, baseline) {
      const id = quoteKey ?? `${task}-${now()}`;
      const w: Watch = {
        bookingId: id,
        task,
        quoteKey: quoteKey ?? "",
        input,
        until: new Date(now() + input.hours * 3_600_000).toISOString(),
        baseline,
        lowest: baseline,
        checks: [baseline],
        alerts: [],
        status: "watching",
      };
      save(w);
      return {
        watchId: id,
        watching: `${input.origin}→${input.destination} on ${input.date}`,
        now: baseline.flight,
        until: w.until,
      };
    },
    extend: routes,
  };
}
