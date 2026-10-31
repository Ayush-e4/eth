import { type ArkivReader, type ArkivWriter, LIFETIME } from "./config";
import { ownEntries } from "./read";

const DAY_S = 86_400;

/**
 * Keeps an agent on the market: its profile and listings live 30 days on Arkiv, so before they
 * run out (fewer than `minDays` left) they're extended to a full 30 days again. Only the agent's
 * own key can do this, and it pays the (tiny) fee. Web2 analogy: renewing a domain before it
 * lapses. Returns what was renewed.
 */
export async function renewOwn(
  w: Pick<ArkivWriter, "extendEntity" | "account">,
  r: ArkivReader,
  opts: { minDays?: number } = {},
) {
  const minLeft = (opts.minDays ?? 10) * DAY_S;
  const entries = await ownEntries(r, w.account.address);
  const renewed: { kind: "agent" | "listing"; key: `0x${string}` }[] = [];
  for (const e of entries) {
    if (e.secondsLeft >= minLeft) continue;
    await w.extendEntity({ entityKey: e.key, expiration: LIFETIME[e.kind]() });
    renewed.push({ kind: e.kind, key: e.key });
  }
  return renewed;
}
