import { arkivReader, arkivWriter, findListings, postQuote, publishAgent } from "@eth/arkiv";
import { type Facilitator, paywall } from "@eth/x402";
import { Hono } from "hono";
import type { SpecialistIdentity } from "../identities";
import { type TaskBody, TaskBodySchema } from "../trip";

/** What makes one specialist different from another: how it quotes and how it does the work. */
export interface SpecialistDef<Detail, Result> {
  name: string;
  skill: string;
  title: string;
  description: string;
  priceUnits: bigint; // agent fee per job, USDC base units
  /** Look up the best option for the trip (no side effects). */
  quote(body: TaskBody): Promise<{ note: string; detail: Detail }>;
  /** Do the job for a quote the buyer accepted and paid for. */
  work(body: TaskBody, detail: Detail): Promise<Result>;
}

const QUOTE_TTL_SECONDS = 180;

export interface SpecialistContext {
  identity: SpecialistIdentity;
  baseUrl: string; // where this agent is reachable, published on Arkiv
  facilitator: Facilitator;
  usdcTokenId: string;
  executorId: string; // MandateRegistry contract id admitted for payments
}

/**
 * A specialist agent as an HTTP service:
 *   GET  /        → profile
 *   POST /quote   → free; finds the best option and posts a 3-minute quote on Arkiv
 *   POST /work    → x402-paywalled (agent fee via MandateRegistry); does the job
 */
export function createSpecialist<D, R>(def: SpecialistDef<D, R>, ctx: SpecialistContext) {
  const writer = arkivWriter(ctx.identity.key);
  // quote key → detail, so /work does exactly what was quoted (and only while the quote is live)
  const quotes = new Map<string, { detail: D; expiresAt: number }>();
  const live = (key: string | undefined) => {
    const q = key ? quotes.get(key) : undefined;
    return q && q.expiresAt > Date.now() ? q : undefined;
  };
  const app = new Hono();

  app.get("/", (c) =>
    c.json({
      name: def.name,
      skill: def.skill,
      agent: ctx.identity.evm,
      price: def.priceUnits.toString(),
    }),
  );

  app.post("/quote", async (c) => {
    const body = TaskBodySchema.parse(await c.req.json());
    const { note, detail } = await def.quote(body);
    const { entityKey } = await postQuote(
      writer,
      {
        agent: ctx.identity.evm,
        task: body.task,
        skill: def.skill,
        priceUnits: def.priceUnits,
        note,
      },
      QUOTE_TTL_SECONDS,
    );
    quotes.set(entityKey, { detail, expiresAt: Date.now() + QUOTE_TTL_SECONDS * 1000 });
    return c.json({ quoteKey: entityKey, priceUnits: def.priceUnits.toString(), note });
  });

  app.post(
    "/work",
    // Check the quote BEFORE the paywall, so nobody pays for a quote we can't honour.
    async (c, next) => {
      const body = TaskBodySchema.safeParse(await c.req.json());
      if (!body.success) return c.json({ error: "invalid_body" }, 400);
      if (!live(body.data.quoteKey)) return c.json({ error: "unknown_or_expired_quote" }, 409);
      await next();
    },
    paywall({
      network: "hedera:testnet",
      asset: ctx.usdcTokenId,
      amount: def.priceUnits.toString(),
      payTo: ctx.identity.hederaAccount,
      executors: [ctx.executorId],
      facilitator: ctx.facilitator,
      description: def.title,
    }),
    async (c) => {
      const body = TaskBodySchema.parse(await c.req.json());
      const quote = live(body.quoteKey);
      if (!quote) return c.json({ error: "unknown_or_expired_quote" }, 409);
      quotes.delete(body.quoteKey as string); // one job per quote
      const result = await def.work(body, quote.detail);
      return c.json({ agent: def.name, result });
    },
  );

  /** Publish profile + listing on Arkiv unless this agent already has a live listing. */
  async function publish() {
    const existing = await findListings(arkivReader(), { skill: def.skill });
    const mine = existing.find(
      (l) => l.record.agent.toLowerCase() === ctx.identity.evm.toLowerCase(),
    );
    if (mine) return { alreadyListed: true as const };
    const endpoint = ctx.baseUrl;
    const r = await publishAgent(
      writer,
      {
        agent: ctx.identity.evm,
        name: def.name,
        skill: def.skill,
        hederaAccount: ctx.identity.hederaAccount,
        description: def.description,
        endpoint,
      },
      [
        {
          agent: ctx.identity.evm,
          skill: def.skill,
          priceUnits: def.priceUnits,
          acceptsCredits: false,
          title: def.title,
          endpoint,
        },
      ],
    );
    return { alreadyListed: false as const, txHash: r.txHash };
  }

  return { app, publish };
}
