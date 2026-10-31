import { type ArkivWriter, recordDelivery } from "@eth/arkiv";
import {
  decodeX402Authorization,
  decodeX402EscrowAuthorization,
  escrowIdOf,
  type PaymentState,
} from "@eth/mandates";
import { TASK_ERRORS, type TaskRequest } from "@eth/shared";
import { HEADERS, paymentResponseHeader, readPaymentHeader } from "@eth/x402";
import type { Context, Hono, MiddlewareHandler } from "hono";
import type { Hex } from "viem";
import { AUTH, verifySigned } from "../auth";
import { escrowJobs, resultHash } from "./escrow";
import type { Job, JobStore, Refund } from "./jobs";
import type { SpecialistContext, SpecialistDef } from "./server";

const RECHECK_MS = 10_000;
const SWEEP_MS = 60_000; // open escrows: retry, refund disputes, claim after the review window

type Parsed<I> =
  | { req: TaskRequest<I>; error?: undefined }
  | { req?: undefined; error: string; status: 400 | 422; issues?: unknown };

export interface WorkDeps<I, D, R> {
  def: SpecialistDef<I, D, R>;
  ctx: SpecialistContext;
  jobs: JobStore;
  writer: ArkivWriter;
  parseTask(raw: unknown): Parsed<I>;
  feeWall: MiddlewareHandler;
  log?: (line: string) => void;
}

/**
 * Paid work that survives crashes. POST /work claims the quote and records the payment before it
 * settles; the job then moves paying → working → delivered / failed (refunded), saved at each
 * step. With pay on delivery (ctx.escrow) the fee waits in MandateRegistry until delivered. Sending the same /work again is safe: the buyer gets its job back, never a second
 * payment or a second booking. A buyer that signs /work reads the job later at GET /jobs/:quote.
 * After a restart, recover() finishes what was left half-way (see the README in docs/agents.md).
 */
export function workRoutes<I, D, R>(app: Hono, w: WorkDeps<I, D, R>) {
  const { def, ctx, jobs } = w;
  const log = w.log ?? (() => {});
  const watching = new Set<string>();
  const escrow = escrowJobs(ctx.escrow, jobs, log);

  /** What the buyer sees of its job. */
  const view = (j: Job) => ({
    job: j.quoteKey,
    status: j.status,
    agent: def.name,
    payTo: ctx.identity.hederaAccount,
    ...(j.paymentTx ? { paymentTx: j.paymentTx } : {}),
    // Paid on delivery: the buyer releases this escrow once it has the result.
    ...(j.escrow ? { escrow: { id: j.escrow.id, deliveredTx: j.escrow.deliveredTx } } : {}),
    ...(j.status === "delivered" ? { result: j.result } : {}),
    ...(j.status === "failed"
      ? { error: TASK_ERRORS.workFailed, detail: j.error, refund: j.refund }
      : {}),
  });
  const reply = (c: Context, j: Job) =>
    c.json(view(j), j.status === "delivered" ? 200 : j.status === "failed" ? 502 : 202);

  // An escrowed fee goes back from the registry; a direct one from our own account.
  const refund = (j: Job, memo: string): Promise<Refund | undefined> =>
    j.escrow
      ? escrow.refund(j)
      : ctx.refund
        ? ctx.refund(j.payment.payer, def.priceUnits, memo).then(
            (transaction): Refund => ({ transaction }),
            (e: unknown): Refund => ({ failed: String(e).slice(0, 200) }),
          )
        : Promise.resolve(undefined);

  /** The public record of how the job ended (best effort: the job itself is settled already). */
  function announce(j: Job) {
    if (!/^0x[0-9a-f]{64}$/i.test(j.quoteKey)) return; // only real Arkiv quotes
    const done = j.status === "delivered";
    const refundTx = j.refund && "transaction" in j.refund ? j.refund.transaction : undefined;
    if (!done && !refundTx) return;
    const hash = resultHash(j.result);
    recordDelivery(w.writer, {
      task: j.task,
      agent: ctx.identity.evm,
      quote: j.quoteKey as `0x${string}`,
      status: done ? "delivered" : "refunded",
      ...(done ? { resultHash: hash } : { refundTx }),
    }).catch((err) => log(`${def.name}: delivery record failed: ${String(err).slice(0, 120)}`));
  }

  /** Paid: do exactly the quoted job, then deliver it or give the fee back. */
  async function perform(key: string): Promise<Job> {
    const j = jobs.job(key) as Job;
    const quote = jobs.quote<D>(key);
    try {
      if (!quote) throw new Error("the quote's details are gone");
      const result = await def.work(j.request as TaskRequest<I>, quote.detail);
      jobs.update(key, { status: "delivered", result });
      await escrow.delivered(jobs.job(key) as Job); // before the buyer hears, so it can release
    } catch (err) {
      const detail = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      const r = await refund(j, `refund ${j.task}`);
      jobs.update(key, { status: "failed", error: detail, ...(r ? { refund: r } : {}) });
    }
    const done = jobs.job(key) as Job;
    announce(done);
    return done;
  }

  /** A payment whose outcome we didn't see (we crashed, or the call broke): ask the chain. */
  function watch(key: string) {
    const check = ctx.paymentState;
    if (!check || watching.has(key)) return;
    watching.add(key);
    const tick = async () => {
      const j = jobs.job(key);
      if (j?.status !== "paying") return watching.delete(key);
      const p = j.payment;
      const s: PaymentState = await check({
        mandateId: BigInt(p.mandateId),
        nonce: BigInt(p.nonce),
        validBefore: BigInt(p.validBefore),
      }).catch(() => ({ state: "pending" }));
      if (s.state === "pending") return void setTimeout(() => void tick(), RECHECK_MS).unref();
      watching.delete(key);
      if (s.state === "unpaid") {
        jobs.release(key);
        return log(`${def.name}: ${j.task} was never paid; quote free again`);
      }
      jobs.update(key, {
        status: "working",
        ...(s.transaction ? { paymentTx: s.transaction } : {}),
      });
      log(`${def.name}: ${j.task} turned out paid; doing the job`);
      await perform(key);
    };
    void tick();
  }

  app.post("/work", async (c) => {
    const parsed = w.parseTask(await c.req.json().catch(() => null));
    if (!parsed.req) return c.json({ error: parsed.error, issues: parsed.issues }, parsed.status);
    const req = parsed.req;
    const key = req.quoteKey ?? "";
    // A buyer that signs its request can get its job back later (retries, GET /jobs).
    let buyer: string | null = null;
    if (c.req.header(AUTH.signature)) {
      const body = await c.req.text();
      buyer = await verifySigned((n) => c.req.header(n), "POST", c.req.path, body).then(
        (a) => a.toLowerCase(),
        () => null,
      );
      if (!buyer) return c.json({ error: "bad_signature" }, 401);
    }
    const mine = (j: Job | null) => !!j?.buyer && j.buyer === buyer;
    const existing = jobs.job(key);
    if (existing)
      return mine(existing) ? reply(c, existing) : c.json({ error: TASK_ERRORS.quoteUsed }, 409);

    // Check the quote BEFORE the paywall, so nobody pays for a quote we can't honour.
    const quote = jobs.quote<D>(key);
    if (!quote || quote.expiresAt <= Date.now())
      return c.json({ error: TASK_ERRORS.unknownQuote }, 409);
    const problem = await def.check?.(req, quote.detail);
    if (problem) return c.json({ error: TASK_ERRORS.invalidInput, detail: problem }, 422);

    // No payment yet (or an unreadable one): the paywall answers 402 with what to pay.
    const payment = readPaymentHeader(c.req.header(HEADERS.signature));
    const auth = payment ? safeAuth(payment.payload.authorization as Hex, !!ctx.escrow) : null;
    if (!payment || !auth) return (await w.feeWall(c, async () => {})) as Response;

    // Record the payment before it settles: if we crash now, the chain tells us later.
    const claimed = jobs.claim({
      quoteKey: key,
      task: req.task,
      buyer,
      request: req,
      payment: {
        payer: String(payment.payload.payer),
        mandateId: auth.mandateId.toString(),
        nonce: auth.nonce.toString(),
        validBefore: auth.validBefore.toString(),
      },
      ...(ctx.escrow ? { escrow: { id: escrowIdOf(auth.mandateId, auth.nonce) } } : {}),
    });
    if (!claimed) {
      const j = jobs.job(key);
      return j && mine(j) ? reply(c, j) : c.json({ error: TASK_ERRORS.quoteUsed }, 409);
    }
    const out: { settled?: Parameters<typeof paymentResponseHeader>[0] } = {};
    try {
      const refused = await w.feeWall(c, async () => {
        out.settled = c.get("x402Settlement" as never) as typeof out.settled;
      });
      if (!out.settled) {
        jobs.release(key); // refused or cancelled: nothing was paid
        return refused as Response;
      }
    } catch (err) {
      log(`${def.name}: payment for ${req.task} broke off (${String(err).slice(0, 80)}); watching`);
      watch(key);
      return reply(c, jobs.job(key) as Job); // 202: the buyer polls GET /jobs
    }
    jobs.update(key, { status: "working", paymentTx: out.settled.transaction });
    const res = reply(c, await perform(key));
    res.headers.set(HEADERS.response, paymentResponseHeader(out.settled));
    return res;
  });

  /** The buyer reads its job back (signed by the same key that signed /work). */
  app.get("/jobs/:key", async (c) => {
    const signer = await verifySigned((n) => c.req.header(n), "GET", c.req.path, "").then(
      (a) => a.toLowerCase(),
      () => null,
    );
    if (!signer) return c.json({ error: "unsigned_request" }, 401);
    const j = jobs.job(c.req.param("key"));
    return j?.buyer === signer ? c.json(view(j)) : c.json({ error: "not_found" }, 404);
  });

  return {
    /**
     * After a restart. Jobs still "paying": the chain says whether they were paid (then we do
     * them) or not (the quote is freed). Jobs "working" stopped mid-job: doing them again could
     * book twice, so the fee goes back instead.
     */
    recover() {
      if (ctx.escrow) setInterval(() => void escrow.sweep().catch(() => {}), SWEEP_MS).unref();
      const left = jobs.unfinished();
      for (const j of left) {
        if (j.status === "paying") watch(j.quoteKey);
        else
          void refund(j, `refund ${j.task} (interrupted)`).then((r) => {
            jobs.update(j.quoteKey, {
              status: "failed",
              error: "interrupted by a restart before it finished",
              ...(r ? { refund: r } : {}),
            });
            announce(jobs.job(j.quoteKey) as Job);
          });
      }
      return left.length;
    },
  };
}

function safeAuth(authorization: Hex, escrow: boolean) {
  try {
    return escrow
      ? decodeX402EscrowAuthorization(authorization)
      : decodeX402Authorization(authorization);
  } catch {
    return null;
  }
}
