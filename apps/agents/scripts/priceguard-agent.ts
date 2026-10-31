// PriceGuard as the market runs it: its watches in a gitignored file, checked on a schedule.
//   PRICEGUARD_EVERY_MIN  minutes between rounds (default 60; each check locks a hotel rate)
import { fileURLToPath } from "node:url";
import { fetchInrRates } from "../src/orchestrator/procure";
import { priceGuard, type Watch } from "../src/specialists/priceguard";
import type { SpecialistContext } from "../src/specialists/server";
import { JsonStore } from "../src/store";

const STORE = fileURLToPath(new URL("../.priceguard.local.json", import.meta.url));

export function priceguardAgent(ctx: SpecialistContext) {
  const guard = priceGuard(ctx, {
    store: new JsonStore<Watch>(STORE),
    inrPerUsdc: async () => (await fetchInrRates()).USDC ?? 0,
  });
  const every = Number(process.env.PRICEGUARD_EVERY_MIN ?? 60) * 60_000;
  const t = setInterval(() => void guard.checkOnce(ctx.log ?? (() => {})), every);
  t.unref?.();
  return guard;
}
