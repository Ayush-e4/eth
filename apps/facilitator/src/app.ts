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
  facilitator: Pick<ExecutorFacilitator, "supported" | "verify" | "settle">,
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

  return app;
}
