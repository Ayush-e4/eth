import { z } from "zod";

/** Response shape of every service's GET /health endpoint. */
export const HealthSchema = z.object({
  service: z.string(),
  status: z.literal("ok"),
  time: z.iso.datetime(),
});

export type Health = z.infer<typeof HealthSchema>;

export function health(service: string): Health {
  return { service, status: "ok", time: new Date().toISOString() };
}

export const APP = {
  name: "eth",
  tagline: "AI agents that do real-world tasks, hire and pay each other — within onchain mandates.",
} as const;
export * from "./chat";
export * from "./task";
