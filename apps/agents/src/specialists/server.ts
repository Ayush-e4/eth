import { arkivReader, arkivWriter, findListings, postQuote, publishAgent } from "@eth/arkiv";
import { type Subcontract, TASK_ERRORS, type TaskRequest, TaskRequestSchema } from "@eth/shared";
import { type Facilitator, paywall } from "@eth/x402";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { SpecialistIdentity } from "../identities";

/** A specialist's answer to /quote: what it found, and what the item itself costs. */
export interface Quoted<Detail> {
  note: string;
  detail: Detail;
  itemTotal: number; // ticket / room price in the provider's currency (signed on Arkiv)
  itemCurrency: string;
  subcontract?: Subcontract; // for agents that hire others: who, and the budget they need
}

/** What makes one specialist different from another: what it accepts, how it quotes and works. */
export interface SpecialistDef<Input, Detail, Result> {
  name: string;
  skill: string;
  title: string;
  description: string;
  priceUnits: bigint; // agent fee per job, USDC base units
  /** The skill-specific `input` it accepts; published as JSON Schema on GET /. */
  input: z.ZodType<Input>;
  /** Look up the best option for the request (no side effects). */
  quote(req: TaskRequest<Input>): Promise<Quoted<Detail>>;
  /** Optional check before the fee is taken (e.g. a delegation is in place); returns a problem. */
  check?(req: TaskRequest<Input>, detail: Detail): Promise<string | null>;
  /** Do the job for a quote the buyer accepted and paid for. */
  work(req: TaskRequest<Input>, detail: Detail): Promise<Result>;
  /** Extra routes (e.g. managing what was booked), mounted on the same service. */
  extend?(app: Hono, kit: SpecialistKit): void;
}

/** Building blocks a specialist's extra routes can use. */
export interface SpecialistKit {
  writer: ReturnType<typeof arkivWriter>;
  ctx: SpecialistContext;
  /** x402 paywall for a fee to this agent's own account. */
  feeWall(units: bigint, description: string): MiddlewareHandler;
  /** After a paid request failed: send the fee back to whoever paid it. */
  refundPaid(c: Context, units: bigint, memo: string): Promise<Refund | undefined>;
}

export type Refund = { transaction: string } | { failed: string };

const QUOTE_TTL_SECONDS = 180;

export interface SpecialistContext {
  identity: SpecialistIdentity;
  baseUrl: string; // where this agent is reachable, published on Arkiv
  facilitator: Facilitator;
  usdcTokenId: string;
  executorId: string; // MandateRegistry contract id admitted for payments
  /** Sends a fee back from the agent's own account (paid, then couldn't deliver). Returns the tx id. */
  refund?: (to: string, units: bigint, memo: string) => Promise<string>;
}

/**
 * A specialist agent as an HTTP service:
 *   GET  /        → profile
 *   POST /quote   → free; finds the best option and posts a 3-minute quote on Arkiv
 *   POST /work    → x402-paywalled (agent fee via MandateRegistry); does the job
 */
export function createSpecialist<I, D, R>(def: SpecialistDef<I, D, R>, ctx: SpecialistContext) {
  // Same envelope for every agent; the skill must be ours and `input` must fit our schema.
  const parseTask = (raw: unknown) => {
    const env = TaskRequestSchema.safeParse(raw);
    if (!env.success) return { error: TASK_ERRORS.invalidBody, status: 400 as const };
    if (env.data.skill !== def.skill)
      return { error: TASK_ERRORS.wrongSkill, status: 400 as const };
    const input = def.input.safeParse(env.data.input);
    if (!input.success)
      return { error: TASK_ERRORS.invalidInput, status: 422 as const, issues: input.error.issues };
    return { req: { ...env.data, input: input.data } as TaskRequest<I> };
  };
  const inputSchema = z.toJSONSchema(def.input, { unrepresentable: "any" });
  const writer = arkivWriter(ctx.identity.key);
  // quote key → detail, so /work does exactly what was quoted (and only while the quote is live)
  const quotes = new Map<string, { detail: D; expiresAt: number }>();
  const live = (key: string | undefined) => {
    const q = key ? quotes.get(key) : undefined;
    return q && q.expiresAt > Date.now() ? q : undefined;
  };
  const app = new Hono();
  const feeWall = (units: bigint, description: string) =>
    paywall({
      network: "hedera:testnet",
      asset: ctx.usdcTokenId,
      amount: units.toString(),
      payTo: ctx.identity.hederaAccount,
      executors: [ctx.executorId],
      facilitator: ctx.facilitator,
      description,
    });
  const refundPaid = async (c: Context, units: bigint, memo: string) => {
    const payer = (c.get("x402Settlement" as never) as { payer?: string } | undefined)?.payer;
    if (!payer || !ctx.refund) return undefined;
    return ctx
      .refund(payer, units, memo)
      .then((transaction): Refund => ({ transaction }))
      .catch((e: unknown): Refund => ({ failed: String(e).slice(0, 200) }));
  };

  app.get("/", (c) =>
    c.json({
      name: def.name,
      skill: def.skill,
      agent: ctx.identity.evm,
      price: def.priceUnits.toString(),
      inputSchema,
    }),
  );

  app.post("/quote", async (c) => {
    const parsed = parseTask(await c.req.json().catch(() => null));
    if (!parsed.req) return c.json({ error: parsed.error, issues: parsed.issues }, parsed.status);
    const body = parsed.req;
    let quoted: Quoted<D>;
    try {
      quoted = await def.quote(body);
    } catch (err) {
      // A plain "no" the buyer can read (sold out, no route), not a server error.
      const detail = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      return c.json({ error: TASK_ERRORS.noOffer, detail }, 422);
    }
    const { note, detail, itemTotal, itemCurrency, subcontract } = quoted;
    const { entityKey } = await postQuote(
      writer,
      {
        agent: ctx.identity.evm,
        task: body.task,
        skill: def.skill,
        priceUnits: def.priceUnits,
        note,
        itemTotal,
        itemCurrency,
      },
      QUOTE_TTL_SECONDS,
    );
    quotes.set(entityKey, { detail, expiresAt: Date.now() + QUOTE_TTL_SECONDS * 1000 });
    return c.json({
      quoteKey: entityKey,
      priceUnits: def.priceUnits.toString(),
      note,
      itemTotal,
      itemCurrency,
      subcontract,
    });
  });

  app.post(
    "/work",
    // Check the quote BEFORE the paywall, so nobody pays for a quote we can't honour.
    async (c, next) => {
      const parsed = parseTask(await c.req.json().catch(() => null));
      if (!parsed.req) return c.json({ error: parsed.error, issues: parsed.issues }, parsed.status);
      const quote = live(parsed.req.quoteKey);
      if (!quote) return c.json({ error: TASK_ERRORS.unknownQuote }, 409);
      const problem = await def.check?.(parsed.req, quote.detail);
      if (problem) return c.json({ error: TASK_ERRORS.invalidInput, detail: problem }, 422);
      await next();
    },
    feeWall(def.priceUnits, def.title),
    async (c) => {
      const body = parseTask(await c.req.json()).req as TaskRequest<I>; // checked above
      const quote = live(body.quoteKey);
      if (!quote) return c.json({ error: TASK_ERRORS.unknownQuote }, 409);
      quotes.delete(body.quoteKey as string); // one job per quote
      try {
        const result = await def.work(body, quote.detail);
        return c.json({ agent: def.name, result });
      } catch (err) {
        // Paid but couldn't deliver → give the fee back (until pay-on-delivery escrow exists).
        const detail = (err instanceof Error ? err.message : String(err)).slice(0, 500);
        const refund = await refundPaid(c, def.priceUnits, `refund ${body.task}`);
        return c.json({ error: TASK_ERRORS.workFailed, detail, refund }, 502);
      }
    },
  );

  def.extend?.(app, { writer, ctx, feeWall, refundPaid });

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

  return { name: def.name, app, publish };
}
