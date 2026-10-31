import {
  arkivReader,
  arkivWriter,
  type Decoded,
  findListings,
  postQuote,
  publishAgent,
  type Task,
} from "@eth/arkiv";
import type { PaymentState } from "@eth/mandates";
import { type Subcontract, TASK_ERRORS, type TaskRequest, TaskRequestSchema } from "@eth/shared";
import { type EscrowTerms, type Facilitator, paywall } from "@eth/x402";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { SpecialistIdentity } from "../identities";
import type { EscrowMoves } from "./escrow";
import { type JobStore, jobStore, type Refund } from "./jobs";
import { workRoutes } from "./work";

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

export type { Refund };

const QUOTE_TTL_SECONDS = 180;

export interface SpecialistContext {
  identity: SpecialistIdentity;
  baseUrl: string; // where this agent is reachable, published on Arkiv
  facilitator: Facilitator;
  usdcTokenId: string;
  executorId: string; // MandateRegistry contract id admitted for payments
  /** Sends a fee back from the agent's own account (paid, then couldn't deliver). Returns the tx id. */
  refund?: (to: string, units: bigint, memo: string) => Promise<string>;
  /** Its quotes and paid jobs (a file in production; in memory when omitted, e.g. tests). */
  jobs?: JobStore;
  /** Pay on delivery: the /work fee waits in MandateRegistry until the job is delivered. */
  escrow?: EscrowMoves;
  /** Asks the chain whether a payment happened (recovering jobs after a crash). */
  paymentState?: (p: {
    mandateId: bigint;
    nonce: bigint;
    validBefore: bigint;
  }) => Promise<PaymentState>;
  log?: (line: string) => void;
}

/**
 * A specialist agent as an HTTP service:
 *   GET  /        → profile
 *   POST /quote   → free; finds the best option and posts a 3-minute quote on Arkiv
 *   POST /work    → x402-paywalled (agent fee via MandateRegistry); does the job (see work.ts)
 *   GET  /jobs/:q → the buyer reads its job back
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
  // The input view: fields with defaults are optional to send.
  const inputSchema = z.toJSONSchema(def.input, { unrepresentable: "any", io: "input" });
  const writer = arkivWriter(ctx.identity.key);
  // quote key → detail, so /work does exactly what was quoted; saved, so a restart keeps it
  const jobs = ctx.jobs ?? jobStore();
  const app = new Hono();
  const feeWall = (units: bigint, description: string, escrow?: EscrowTerms) =>
    paywall({
      ...(escrow ? { escrow } : {}),
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

  /** Quote a request and sign the bid on Arkiv; /work honours it while it lives. */
  async function bid(req: TaskRequest<I>) {
    const quoted = await def.quote(req);
    const { note, detail, itemTotal, itemCurrency } = quoted;
    const { entityKey } = await postQuote(
      writer,
      {
        agent: ctx.identity.evm,
        task: req.task,
        skill: def.skill,
        priceUnits: def.priceUnits,
        note,
        itemTotal,
        itemCurrency,
      },
      QUOTE_TTL_SECONDS,
    );
    jobs.saveQuote(entityKey, req.task, detail, Date.now() + QUOTE_TTL_SECONDS * 1000);
    return { entityKey, quoted };
  }

  app.post("/quote", async (c) => {
    const parsed = parseTask(await c.req.json().catch(() => null));
    if (!parsed.req) return c.json({ error: parsed.error, issues: parsed.issues }, parsed.status);
    let done: Awaited<ReturnType<typeof bid>>;
    try {
      done = await bid(parsed.req);
    } catch (err) {
      // A plain "no" the buyer can read (sold out, no route), not a server error.
      const detail = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      return c.json({ error: TASK_ERRORS.noOffer, detail }, 422);
    }
    const { note, itemTotal, itemCurrency, subcontract } = done.quoted;
    return c.json({
      quoteKey: done.entityKey,
      priceUnits: def.priceUnits.toString(),
      note,
      itemTotal,
      itemCurrency,
      subcontract,
    });
  });

  const work = workRoutes(app, {
    def,
    ctx,
    jobs,
    writer,
    parseTask,
    feeWall: feeWall(def.priceUnits, def.title, ctx.escrow?.terms),
    log: ctx.log,
  });

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

  /**
   * An open task from Arkiv (the market's shared watcher hands them out): bid once if it's our
   * skill, the poster's fee cap covers our fee, and the input is something we can quote.
   */
  const seen = new Set<string>();
  function considerTask(t: Decoded<Task>, log = (_: string) => {}) {
    if (t.record.skill !== def.skill || seen.has(t.key)) return;
    seen.add(t.key);
    if (t.record.maxFeeUnits < def.priceUnits) return; // too cheap for us
    const input = def.input.safeParse(t.record.input);
    if (!input.success) {
      const why = input.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      return log(`${def.name} can't bid on ${t.record.task}: ${why.slice(0, 160)}`);
    }
    bid({ task: t.record.task, skill: def.skill, input: input.data })
      .then(() => log(`${def.name} bid on task ${t.record.task}`))
      .catch((err) => log(`${def.name} passed on ${t.record.task}: ${String(err).slice(0, 120)}`));
  }

  return {
    name: def.name,
    skill: def.skill,
    app,
    publish,
    considerTask,
    /** After a restart: finish or refund the jobs the last run left half-way. */
    recover: work.recover,
  };
}
