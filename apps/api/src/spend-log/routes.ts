import { type ArkivReader, arkivReader, findAgents } from "@eth/arkiv";
import { Mirror } from "@eth/hedera";
import { Hono } from "hono";
import type { HiringEnv } from "../hiring/env";

export interface LogEntry {
  seq: number;
  at: string; // consensus time, ISO
  kind: string;
  [field: string]: unknown;
}

const CACHE_MS = 5_000;

/** Who's who in the log: agents' names from their Arkiv profiles, by Hedera account and EVM address. */
export type LogNames = () => Promise<Record<string, string>>;

export const arkivNames =
  (reader: ArkivReader = arkivReader()): LogNames =>
  async () => {
    const names: Record<string, string> = {};
    for (const { record: a } of await findAgents(reader)) {
      names[a.hederaAccount] = a.name;
      names[a.agent.toLowerCase()] = a.name;
    }
    return names;
  };

/** "1793308077.058257691" (seconds.nanos) → ISO time. */
const consensusTime = (ts: string) => new Date(Number(ts.split(".")[0]) * 1000).toISOString();

/**
 * The public spend log, read back from Hedera's mirror node: payments the facilitator settled,
 * limits created and cancelled, agents hired. Public on purpose, like the topic itself.
 */
export function spendLogRoutes(env: HiringEnv | null, names?: LogNames, mirror?: Mirror) {
  const app = new Hono();
  let cached: { at: number; entries: LogEntry[]; names: Record<string, string> } | null = null;

  app.get("/spend-log", async (c) => {
    const topic = env?.log?.topicId;
    if (!env || !topic) return c.json({ error: "the spend log is not configured" }, 503);
    if (!cached || Date.now() - cached.at > CACHE_MS) {
      const messages = await (mirror ?? new Mirror(env.mirrorUrl))
        .topicMessages(topic, 100)
        .catch(() => null);
      if (!messages) return c.json({ error: "Hedera's mirror node didn't answer" }, 502);
      cached = {
        at: Date.now(),
        names: {
          ...(await names?.().catch(() => ({}))),
          [env.demo.account]: "the demo wallet",
          [env.demo.evm.toLowerCase()]: "the demo wallet",
        },
        entries: messages.map((m) => {
          let body: Record<string, unknown> = { kind: "note", text: m.text };
          try {
            const parsed = JSON.parse(m.text);
            if (parsed && typeof parsed === "object" && typeof parsed.kind === "string")
              body = parsed;
          } catch {
            // not ours: keep it as a plain note
          }
          return { ...body, seq: m.sequence, at: consensusTime(m.timestamp) } as LogEntry;
        }),
      };
    }
    return c.json({ topic, entries: cached.entries, names: cached.names });
  });

  return app;
}
