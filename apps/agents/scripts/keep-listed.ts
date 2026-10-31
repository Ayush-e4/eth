// Keeps every running agent on the market: renews its Arkiv profile and listings before they
// expire (they live 30 days). Checks at start, then twice a day.
import { arkivReader, arkivWriter, renewOwn } from "@eth/arkiv";
import type { Hex } from "viem";

const EVERY_MS = 12 * 60 * 60_000;

export function keepListed(agents: { name: string; key: Hex }[], log: (line: string) => void) {
  const reader = arkivReader();
  const tick = () => {
    for (const a of agents)
      renewOwn(arkivWriter(a.key), reader)
        .then((done) => done.length && log(`${a.name}: renewed ${done.length} record(s) on Arkiv`))
        .catch((err) => log(`${a.name}: couldn't renew on Arkiv: ${String(err).slice(0, 120)}`));
  };
  tick();
  const timer = setInterval(tick, EVERY_MS);
  return () => clearInterval(timer);
}
