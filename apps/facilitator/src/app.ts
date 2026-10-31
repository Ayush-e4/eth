import type { ExecutorFacilitator, PaymentPayload, PaymentRequirements } from "@eth/x402";
import { Hono } from "hono";
import { z } from "zod";

/** x402 v2 request body for /verify and /settle. */
const BodySchema = z.object({
  x402Version: z.literal(2),
  paymentPayload: z.record(z.string(), z.unknown()),
  paymentRequirements: z.record(z.string(), z.unknown()),
});

/** HTTP surface of the facilitator: GET /supported, POST /verify, POST /settle. */
export function createApp(
  facilitator: Pick<
    ExecutorFacilitator,
    "supported" | "verify" | "settle" | "scheduled" | "cancelScheduled"
  >,
) {
  const app = new Hono();

  app.get("/health", (c) => c.json({ service: "facilitator", status: "ok" }));
  app.get("/supported", (c) => c.json(facilitator.supported()));

  for (const route of ["verify", "settle"] as const) {
    app.post(`/${route}`, async (c) => {
      const parsed = BodySchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json({ error: "invalid_request", detail: parsed.error.issues[0]?.message }, 400);
      }
      const payment = parsed.data.paymentPayload as unknown as PaymentPayload;
      const requirements = parsed.data.paymentRequirements as unknown as PaymentRequirements;
      const result =
        route === "verify"
          ? await facilitator.verify(payment, requirements)
          : await facilitator.settle(payment, requirements);
      return c.json(result);
    });
  }

  // The undo window: find a payment's schedule by its key, and cancel it (signed by its agent).
  app.get("/schedules/:key", (c) => {
    const p = facilitator.scheduled(c.req.param("key"));
    return p
      ? c.json({ scheduleId: p.scheduleId, executesAt: p.executesAt, status: p.status })
      : c.json({ error: "not_found" }, 404);
  });

  app.post("/schedules/:id/cancel", async (c) => {
    const body = z
      .object({ signature: z.string().regex(/^0x[0-9a-fA-F]+$/) })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ ok: false, reason: "send the agent's signature" }, 400);
    const out = await facilitator.cancelScheduled(
      c.req.param("id"),
      body.data.signature as `0x${string}`,
    );
    return c.json(out, out.ok ? 200 : 409);
  });

  return app;
}
