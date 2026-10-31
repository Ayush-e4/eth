import { type ArkivReader, agentRecords, arkivReader, liveQuotes } from "@eth/arkiv";
import { readRequiredHeader } from "@eth/x402";
import { z } from "zod";
import { safeAgentUrl } from "./safe-url";

export interface Step {
  name: string;
  ok: boolean | null; // null: skipped or optional
  detail: string;
  fix?: string;
}

const ProfileSchema = z.object({
  name: z.string().min(1).max(64),
  skill: z.string().regex(/^[a-z0-9_.-]{1,64}$/),
  agent: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  price: z.string().regex(/^\d+$/),
  inputSchema: z.record(z.string(), z.unknown()),
});
const KIT = "docs/build-an-agent.md";
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const trim = (u: string) => u.replace(/\/+$/, "");

/**
 * "List your agent": checks an agent the way a buyer will use it, step by step, and says how to
 * fix each problem. Listing is open (no approval): an agent that passes is on the Market already.
 * Fetches go to the builder's own URL, so the URL guard refuses private addresses in production.
 */
export function agentChecker(d: {
  mirrorUrl: string;
  usdcTokenId: string;
  executorId: string; // MandateRegistry's Hedera id
  production: boolean;
  reader?: ArkivReader;
  fetchImpl?: typeof fetch;
}) {
  const reader = d.reader ?? arkivReader();
  const fetchImpl = d.fetchImpl ?? fetch;
  const get = (url: string, init?: RequestInit) =>
    fetchImpl(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(8000) });
  const mirror = async <T>(path: string) => {
    const r = await fetchImpl(`${d.mirrorUrl}/api/v1${path}`).catch(() => null);
    return r?.ok ? ((await r.json()) as T) : null;
  };

  return async function check(endpoint: string, sample?: unknown) {
    const steps: Step[] = [];
    const done = (live: boolean, agent?: { address: string; name: string; skill: string }) => ({
      steps,
      live,
      agent,
    });

    const url = await safeAgentUrl(endpoint, d.production);
    steps.push(
      url.ok
        ? { name: "Address", ok: true, detail: url.url }
        : {
            name: "Address",
            ok: false,
            detail: url.reason,
            fix: "Use the public https URL your agent runs at.",
          },
    );
    if (!url.ok) return done(false);
    const base = trim(url.url);

    // 1. Its profile: who it is, its skill, its fee, what it accepts.
    const res = await get(base).catch(() => null);
    const profile = ProfileSchema.safeParse(res?.ok ? await res.json().catch(() => null) : null);
    if (!profile.success) {
      steps.push({
        name: "Profile",
        ok: false,
        detail: res ? `GET ${base} answered ${res.status}, not an agent profile` : "no answer",
        fix: `GET / must return { name, skill, agent, price, inputSchema }; the agent kit does this (${KIT}).`,
      });
      return done(false);
    }
    const p = profile.data;
    steps.push({
      name: "Profile",
      ok: true,
      detail: `${p.name}, skill "${p.skill}", agent ${p.agent}`,
    });

    // 2. Its listing on Arkiv, signed with its own key, pointing at this address.
    const records = await agentRecords(reader, p.agent as `0x${string}`).catch(() => null);
    const prof = records?.profiles.find((x) => x.record.skill === p.skill);
    const listing = records?.listings.find((x) => x.record.skill === p.skill);
    const listed = !!prof && !!listing && trim(listing.record.endpoint) === base;
    steps.push(
      listed
        ? {
            name: "Listing on Arkiv",
            ok: true,
            detail: `signed by ${p.agent}, fee ${listing?.record.priceUnits} base units`,
          }
        : {
            name: "Listing on Arkiv",
            ok: false,
            detail:
              !prof || !listing
                ? "no profile and listing written by this agent's key"
                : `listed at ${listing.record.endpoint}, not ${base}`,
            fix: "Start your agent with the kit (run-agent): it publishes its own listing at start. Set AGENT_BASE_URL to this address.",
          },
    );
    if (!listed || !prof) return done(false);

    // 3. Where it gets paid: a Hedera account that can hold test USDC.
    const account = prof.record.hederaAccount;
    const acct = await mirror<{ evm_address?: string; max_automatic_token_associations?: number }>(
      `/accounts/${account}`,
    );
    const held = await mirror<{ tokens: unknown[] }>(
      `/accounts/${account}/tokens?token.id=${d.usdcTokenId}`,
    );
    const canHold = !!held?.tokens.length || (acct?.max_automatic_token_associations ?? 0) !== 0;
    steps.push(
      acct && canHold
        ? { name: "Paid to", ok: true, detail: `Hedera account ${account}` }
        : {
            name: "Paid to",
            ok: false,
            detail: acct
              ? `${account} can't receive test USDC (${d.usdcTokenId})`
              : `${account} isn't on Hedera`,
            fix: "Associate the account with test USDC, or create it with automatic associations (the kit does).",
          },
    );
    if (!acct || !canHold) return done(false);
    const agent = { address: p.agent, name: p.name, skill: p.skill };

    // 4–5. Optional, with a sample input: a real quote on Arkiv, and /work asking to be paid.
    if (sample === undefined) {
      steps.push({
        name: "Quote and payment",
        ok: null,
        detail: "skipped: add a sample input to try them",
      });
      return done(true, agent);
    }
    const task = `check-${Date.now().toString(36)}`;
    const body = (extra: object = {}) =>
      JSON.stringify({ task, skill: p.skill, input: sample, ...extra });
    const q = await get(`${base}/quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body(),
    }).catch(() => null);
    const quote = (q?.ok ? await q.json().catch(() => null) : null) as { quoteKey?: string } | null;
    const onArkiv = quote?.quoteKey
      ? (await liveQuotes(reader, task).catch(() => [])).some(
          (x) => x.key === quote.quoteKey && same(x.creator, p.agent),
        )
      : false;
    steps.push(
      onArkiv
        ? {
            name: "Quote",
            ok: true,
            detail: `signed quote on Arkiv (${quote?.quoteKey?.slice(0, 10)}…)`,
          }
        : {
            name: "Quote",
            ok: false,
            detail: q
              ? `POST /quote answered ${q.status}${quote?.quoteKey ? ", but the quote isn't on Arkiv" : ""}`
              : "no answer",
            fix: "Check the sample matches its input; quote() must not throw. The kit posts the quote on Arkiv.",
          },
    );
    if (!onArkiv) return done(false, agent);
    const w = await get(`${base}/work`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body({ quoteKey: quote?.quoteKey }),
    }).catch(() => null);
    const asks = readRequiredHeader(w?.headers.get("payment-required"))?.accepts?.[0] as
      | { payTo?: string; amount?: string; extra?: { executors?: string[] } }
      | undefined;
    const right =
      w?.status === 402 &&
      asks?.payTo === account &&
      asks?.amount === p.price &&
      !!asks?.extra?.executors?.includes(d.executorId);
    steps.push(
      right
        ? {
            name: "Payment",
            ok: true,
            detail: `asks ${p.price} base units to ${account} through MandateRegistry (x402)`,
          }
        : {
            name: "Payment",
            ok: false,
            detail: w
              ? `unpaid /work answered ${w.status}${asks ? ` asking ${asks.amount} to ${asks.payTo}` : ""}`
              : "no answer",
            fix: `Unpaid /work must answer 402 asking its fee to ${account} through MandateRegistry ${d.executorId}; the kit's paywall does.`,
          },
    );
    return done(right, agent);
  };
}

export type AgentChecker = ReturnType<typeof agentChecker>;
