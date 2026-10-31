import { type ArkivReader, arkivReader, claimFor, liveQuotes, liveTasks } from "@eth/arkiv";
import { Hono } from "hono";
import { type AuthEnv, requireUser } from "../auth/routes";
import { chatStore } from "../chats/store";
import type { Db } from "../db/client";
import type { OpenTaskService } from "./service";

const BOARD_CACHE_MS = 15_000; // Arkiv reads are budgeted; the board needn't be fresher

/**
 * Open tasks over HTTP: a chat's card polls its task's bids (owner only), and the public board
 * lists every live task on Arkiv with its bids and award, read straight from Arkiv.
 */
export function openTaskRoutes(db: Db, tasks: OpenTaskService | null, reader?: ArkivReader) {
  const store = chatStore(db);
  const app = new Hono<AuthEnv>();
  app.use("/chats/:id/open-tasks/*", requireUser(db));

  app.get("/chats/:id/open-tasks/:task/bids", async (c) => {
    if (!tasks) return c.json({ error: "open tasks aren't set up on this server" }, 503);
    const chat = await store.get(c.get("user").id, c.req.param("id")).catch(() => null);
    const b = chat ? await tasks.bids(chat.id, c.req.param("task")) : null;
    if (!b) return c.json({ error: "no such task in this chat" }, 404);
    return c.json({
      status: b.status,
      closesAt: b.closesAt,
      bids: b.refs.map(({ ref, option: o }) => ({
        ref,
        agent: o.title.split(" — ")[0] ?? o.title,
        note: o.note,
        feeUnits: o.feeUnits.toString(),
        totalInr: o.priced ? Math.round(o.priced.totalInr) : null,
        quoteKey: o.key,
      })),
    });
  });

  let board: { at: number; body: unknown } | null = null;
  app.get("/open-tasks", async (c) => {
    if (board && Date.now() - board.at < BOARD_CACHE_MS) return c.json(board.body);
    const r = reader ?? arkivReader();
    const found = await liveTasks(r).catch(() => null);
    if (!found) return c.json({ error: "Arkiv didn't answer" }, 502);
    const head = await r.getBlockNumber();
    const rows = await Promise.all(
      found.slice(0, 20).map(async (t) => {
        const [bids, claim] = await Promise.all([
          liveQuotes(r, t.record.task).catch(() => []),
          t.record.status === "awarded"
            ? claimFor(r, t.record.task, t.record.poster).catch(() => null)
            : Promise.resolve(null),
        ]);
        return {
          task: t.record.task,
          entityKey: t.key,
          poster: t.record.poster,
          skill: t.record.skill,
          title: t.record.title,
          maxFeeUnits: t.record.maxFeeUnits.toString(),
          status: t.record.status,
          secondsLeft: Number((t.expiresAt - head) * 2n), // Arkiv blocks are 2 s
          bids: bids.map((q) => ({
            key: q.key,
            agent: q.record.agent,
            note: q.record.note,
            feeUnits: q.record.priceUnits.toString(),
            secondsLeft: q.secondsLeft,
          })),
          winner: claim
            ? { agent: claim.record.agent, quote: claim.record.quote, claim: claim.key }
            : null,
        };
      }),
    );
    board = { at: Date.now(), body: { tasks: rows } };
    return c.json(board.body);
  });

  return app;
}
