import type { Context, Hono, Next } from "hono";
import type { JsonStore } from "../store";
import type { Watch } from "./priceguard";
import { signerOf } from "./staywise-manage";

/**
 * A PriceGuard watch, for the traveller's agent that set it up (the slip's signer): look at it
 * (limits, checks, invoices), check now (at most once a minute: each check locks a rate with the
 * hotel), or stop it. Requests are signed, like booking management.
 */
export function guardRoutes(
  app: Hono,
  d: { store: JsonStore<Watch>; check: (w: Watch) => Promise<Watch> },
) {
  const lastManual = new Map<string, number>();
  const guard = async (c: Context, next: Next) => {
    const w = d.store.get(c.req.param("task") ?? "");
    if (!w) return c.json({ error: "unknown_watch" }, 404);
    const signer = await signerOf(c);
    if (!signer || signer.toLowerCase() !== w.buyer.toLowerCase())
      return c.json({ error: "not_your_watch" }, 403);
    c.set("watch" as never, w as never);
    await next();
  };
  const watch = (c: Context) => c.get("watch" as never) as Watch;
  const view = (w: Watch) => ({
    task: w.task,
    bookingId: w.bookingId,
    status: w.status,
    limits: w.slip.body,
    checks: w.checks ?? [],
    invoices: w.invoices,
  });

  app.post("/watches/:task/view", guard, (c) => c.json({ watch: view(watch(c)) }));
  app.post("/watches/:task/stop", guard, (c) => {
    const w = { ...watch(c), status: "stopped" as const };
    d.store.set(w.task, w);
    return c.json({ watch: view(w) });
  });
  app.post("/watches/:task/check-now", guard, async (c) => {
    const w = watch(c);
    if (w.status !== "watching") return c.json({ error: "not_watching" }, 409);
    if (Date.now() - (lastManual.get(w.task) ?? 0) < 60_000)
      return c.json({ error: "checked_a_moment_ago" }, 429);
    lastManual.set(w.task, Date.now());
    return c.json({ watch: view(await d.check(w)) });
  });
}
