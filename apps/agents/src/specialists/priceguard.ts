import {
  arkivReader,
  arkivWriter,
  findListings,
  issueInvoice,
  NO_JOB_FEE,
  publishAgent,
} from "@eth/arkiv";
import { paywall } from "@eth/x402";
import { Hono } from "hono";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { type RepriceDelegation, type Signed, signedHeaders, verifyStatement } from "../auth";
import type { JsonStore } from "../store";
import type { SpecialistContext } from "./server";
import { signerOf } from "./staywise-manage";
import type { RepriceAttestation } from "./staywise-reprice";

export const SUCCESS_FEE_PERCENT = 20; // PriceGuard keeps this share of what it saves you

/** One booking PriceGuard watches for a traveller (its own records). */
export interface Watch {
  task: string;
  bookingId: string; // the current booking — moves on after each cheaper rebook
  buyer: `0x${string}`;
  stayEndpoint: string;
  stayAgent: `0x${string}`;
  slip: Signed<RepriceDelegation>;
  status: "watching" | "stopped";
  invoices: {
    key: `0x${string}`;
    units: string;
    saving: number;
    currency: string;
    paid: boolean;
  }[];
}

export interface PriceGuardDeps {
  store: JsonStore<Watch>;
  inrPerUsdc: () => Promise<number>; // to turn a rupee saving into a USDC fee
}

const WatchBody = z.object({
  task: z.string(),
  bookingId: z.string(),
  stayEndpoint: z.url(),
  stayAgent: z.string(),
  delegation: z.custom<Signed<RepriceDelegation>>((v) => !!v && typeof v === "object"),
});

/** The success fee in USDC base units: 20% of the saving, at today's rate. */
export function successFee(savingInr: number, inrPerUsdc: number): bigint {
  return BigInt(
    Math.max(1, Math.round(((savingInr * SUCCESS_FEE_PERCENT) / 100 / inrPerUsdc) * 1e6)),
  );
}

/**
 * PriceGuard: watches hotel prices for travellers who allowed it, has the booking's agent rebook
 * cheaper (book new first, cancel old), and invoices 20% of the saving with the agent's signed
 * proof. It is paid only after the traveller's agent checks that proof.
 */
export function priceGuard(ctx: SpecialistContext, deps: PriceGuardDeps) {
  const me = privateKeyToAccount(ctx.identity.key);
  const writer = arkivWriter(ctx.identity.key);
  const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
  const app = new Hono();

  async function callStay(w: Pick<Watch, "stayEndpoint">, path: string, payload: unknown) {
    const body = JSON.stringify(payload);
    const res = await fetch(`${w.stayEndpoint}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(await signedHeaders(me, "POST", path, body)),
      },
      body,
    });
    const reply = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok)
      throw new Error(`StayWise ${path} → ${res.status} ${JSON.stringify(reply).slice(0, 200)}`);
    return reply;
  }

  app.get("/", (c) =>
    c.json({
      name: "PriceGuard",
      skill: "priceguard",
      agent: me.address,
      successFeePercent: SUCCESS_FEE_PERCENT,
    }),
  );

  // The traveller's agent hands over its signed permission slip; PriceGuard registers it with StayWise.
  app.post("/watch", async (c) => {
    const signer = await signerOf(c);
    const w = WatchBody.parse(await c.req.json());
    const slip = w.delegation;
    const ok =
      (await verifyStatement("reprice-delegation", slip)) &&
      same(slip.signer, signer) &&
      same(slip.body.delegate, me.address) &&
      same(slip.body.agent, w.stayAgent) &&
      slip.body.bookingId === w.bookingId;
    if (!ok) return c.json({ error: "invalid_delegation" }, 403);
    try {
      await callStay(w, `/bookings/${w.bookingId}/delegate`, { delegation: slip });
    } catch (err) {
      return c.json({ error: "stay_refused", detail: String(err).slice(0, 300) }, 502);
    }
    const prev = deps.store.get(w.task);
    deps.store.set(w.task, {
      task: w.task,
      bookingId: w.bookingId,
      buyer: slip.signer,
      stayEndpoint: w.stayEndpoint,
      stayAgent: w.stayAgent as `0x${string}`,
      slip,
      status: "watching",
      invoices: prev?.invoices ?? [],
    });
    return c.json({ watching: true, limits: slip.body });
  });

  // The traveller's agent pays an invoice it has checked; the price is the invoice's amount.
  type Found = { watch: Watch; inv: Watch["invoices"][number] };
  app.post(
    "/invoices/:key/pay",
    async (c, next) => {
      const key = c.req.param("key");
      const watch = deps.store.values().find((w) => w.invoices.some((i) => i.key === key));
      const inv = watch?.invoices.find((i) => i.key === key);
      if (!watch || !inv) return c.json({ error: "unknown_invoice" }, 404);
      if (inv.paid) return c.json({ error: "already_paid" }, 409);
      c.set("found" as never, { watch, inv } as never);
      await next();
    },
    (c, next) =>
      paywall({
        network: "hedera:testnet",
        asset: ctx.usdcTokenId,
        amount: (c.get("found" as never) as Found).inv.units,
        payTo: ctx.identity.hederaAccount,
        executors: [ctx.executorId],
        facilitator: ctx.facilitator,
        description: `PriceGuard success fee (${SUCCESS_FEE_PERCENT}% of saving)`,
      })(c, next),
    (c) => {
      const { watch, inv } = c.get("found" as never) as Found;
      inv.paid = true;
      deps.store.set(watch.task, watch);
      return c.json({ paid: true, invoice: inv.key });
    },
  );

  /** One round of watching: for each booking, reprice if it beats the traveller's limits. */
  async function checkOnce(log: (line: string) => void) {
    for (const w of deps.store.values().filter((x) => x.status === "watching")) {
      const limits = w.slip.body;
      const o = (await callStay(w, `/bookings/${w.bookingId}/reprice-options`, {})) as {
        current: {
          paidTotal: number;
          comparedTotal: number;
          currency: string;
          cancelFeeNow: number;
        };
        option: { optionKey: string; total: number } | null;
        saving: number;
        savingPercent: number;
        simulated: boolean;
      };
      const tag = o.simulated ? " [SIMULATED drop]" : "";
      if (o.current.cancelFeeNow > 0) {
        deps.store.set(w.task, { ...w, status: "stopped" });
        log(`${w.bookingId}: free cancellation has closed — stopped watching`);
        continue;
      }
      if (
        !o.option ||
        o.saving < limits.minSavingInr ||
        o.savingPercent < limits.minSavingPercent
      ) {
        log(
          `${w.bookingId}: best now ${o.option?.total ?? "—"} vs ${o.current.comparedTotal} ${o.current.currency}${tag} — not worth it (needs ≥ ₹${limits.minSavingInr} and ≥ ${limits.minSavingPercent}%)`,
        );
        continue;
      }
      log(
        `${w.bookingId}: can save ${o.saving} ${o.current.currency} (${o.savingPercent}%)${tag} — rebooking`,
      );
      const { proof } = (await callStay(w, `/bookings/${w.bookingId}/reprice`, {
        optionKey: o.option.optionKey,
      })) as { proof: Signed<RepriceAttestation> };
      if (!same(proof.signer, w.stayAgent) || !(await verifyStatement("attestation", proof))) {
        throw new Error("StayWise returned a proof PriceGuard can't verify");
      }
      const a = proof.body;
      const units = successFee(a.saving, await deps.inrPerUsdc());
      const note = `PriceGuard rebooked ${a.hotelName ?? "your hotel"} ${a.checkin}→${a.checkout}: ${a.comparedTotal} → ${a.newTotal} ${a.currency}, saved ${a.saving}${a.simulated ? " (SIMULATED drop, sandbox)" : ""}. Fee ${SUCCESS_FEE_PERCENT}% of saving.`;
      const { entityKey } = await issueInvoice(writer, {
        agent: me.address,
        buyer: w.buyer,
        task: w.task,
        amountUnits: units,
        note,
        proof: JSON.stringify(proof),
      });
      deps.store.set(w.task, {
        ...w,
        bookingId: a.newBookingId,
        invoices: [
          ...w.invoices,
          {
            key: entityKey,
            units: units.toString(),
            saving: a.saving,
            currency: a.currency,
            paid: false,
          },
        ],
      });
      log(
        `${a.oldBookingId} → ${a.newBookingId}: saved ${a.saving} ${a.currency}; invoice ${entityKey} for ${Number(units) / 1e6} USDC`,
      );
    }
  }

  async function publish() {
    const mine = (await findListings(arkivReader(), { skill: "priceguard" })).find((l) =>
      same(l.record.agent, me.address),
    );
    if (mine) return { alreadyListed: true as const };
    const r = await publishAgent(
      writer,
      {
        agent: me.address,
        name: "PriceGuard",
        skill: "priceguard",
        hederaAccount: ctx.identity.hederaAccount,
        description: `Watches your refundable hotel booking; if the price drops it rebooks cheaper and keeps ${SUCCESS_FEE_PERCENT}% of the saving, paid only on proof.`,
        endpoint: ctx.baseUrl,
      },
      [
        {
          agent: me.address,
          skill: "priceguard",
          priceUnits: NO_JOB_FEE, // paid from the saving instead
          acceptsCredits: false,
          title: `PriceGuard — rebooks when hotel prices drop; ${SUCCESS_FEE_PERCENT}% of the saving`,
          endpoint: ctx.baseUrl,
        },
      ],
    );
    return { alreadyListed: false as const, txHash: r.txHash };
  }

  return { name: "PriceGuard", app, publish, checkOnce };
}
