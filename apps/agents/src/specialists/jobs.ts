import { chmodSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { decodeJson, encodeJson } from "@eth/shared";
import type { JobEscrow } from "./escrow";

/**
 * A specialist's own database: the quotes it gave and every paid job, saved as they change, so a
 * restart never forgets a quote it must honour or a job it was paid for. One SQLite file per agent
 * (gitignored, `*.local.db`); in memory for tests. Web2 analogy: the order table behind a shop.
 *
 *   paying ─(paid)→ working ─→ delivered
 *      │                  └──→ failed (fee refunded)
 *      └─(never paid)→ released: the quote can be paid again
 */
export type JobStatus = "paying" | "working" | "delivered" | "failed";

/** The payment the buyer sent, kept before it settles so a crash can't lose track of it. */
export interface JobPayment {
  payer: string; // Hedera account the fee comes from (and a refund goes back to)
  mandateId: string;
  nonce: string;
  validBefore: string; // unix seconds
}

export type Refund = { transaction: string } | { failed: string };

export interface Job<R = unknown> {
  quoteKey: string;
  task: string;
  buyer: string | null; // who signed /work (lowercase address); only they can read the result
  request: unknown; // the /work body, to do exactly the job that was asked for
  payment: JobPayment;
  status: JobStatus;
  paymentTx?: string;
  result?: R;
  error?: string;
  refund?: Refund;
  /** Paid on delivery: the fee waits in MandateRegistry (see escrow.ts). */
  escrow?: JobEscrow;
  updatedAt: number;
}

const json = (v: unknown) => JSON.stringify(encodeJson(v));
const parse = <T>(s: unknown) => (typeof s === "string" ? decodeJson<T>(JSON.parse(s)) : undefined);

export function jobStore(path = ":memory:") {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS quotes (
      key TEXT PRIMARY KEY, task TEXT NOT NULL, detail TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS jobs (
      quote_key TEXT PRIMARY KEY REFERENCES quotes(key), task TEXT NOT NULL, buyer TEXT,
      request TEXT NOT NULL, payment TEXT NOT NULL, status TEXT NOT NULL, payment_tx TEXT,
      result TEXT, error TEXT, refund TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );`);
  // Added with pay on delivery; older files get the column on first open.
  const cols = db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "escrow")) db.exec("ALTER TABLE jobs ADD COLUMN escrow TEXT");
  // Bookings and buyers' details: readable by this user only (like the *.local.json stores).
  for (const f of [path, `${path}-wal`, `${path}-shm`])
    if (path !== ":memory:" && existsSync(f)) chmodSync(f, 0o600);

  const toJob = (r: Record<string, unknown>): Job => ({
    quoteKey: r.quote_key as string,
    task: r.task as string,
    buyer: (r.buyer as string | null) ?? null,
    request: parse(r.request),
    payment: parse<JobPayment>(r.payment) as JobPayment,
    status: r.status as JobStatus,
    ...(r.payment_tx ? { paymentTx: r.payment_tx as string } : {}),
    ...(r.result != null ? { result: parse(r.result) } : {}),
    ...(r.error ? { error: r.error as string } : {}),
    ...(r.refund ? { refund: parse<Refund>(r.refund) } : {}),
    ...(r.escrow ? { escrow: parse<JobEscrow>(r.escrow) } : {}),
    updatedAt: Number(r.updated_at),
  });

  return {
    saveQuote(key: string, task: string, detail: unknown, expiresAt: number) {
      db.prepare("INSERT OR REPLACE INTO quotes VALUES (?, ?, ?, ?)").run(
        key,
        task,
        json(detail),
        expiresAt,
      );
      // Quotes nobody paid for are only worth keeping a day.
      db.prepare(
        "DELETE FROM quotes WHERE expires_at < ? AND key NOT IN (SELECT quote_key FROM jobs)",
      ).run(Date.now() - 86_400_000);
    },

    quote<D>(key: string): { detail: D; expiresAt: number } | null {
      const r = db.prepare("SELECT detail, expires_at FROM quotes WHERE key = ?").get(key);
      return r ? { detail: parse<D>(r.detail) as D, expiresAt: Number(r.expires_at) } : null;
    },

    /** Takes the quote for one job. False if it already has one: one job per quote, ever. */
    claim(j: Pick<Job, "quoteKey" | "task" | "buyer" | "request" | "payment" | "escrow">) {
      const now = Date.now();
      const r = db
        .prepare(
          `INSERT OR IGNORE INTO jobs (quote_key, task, buyer, request, payment, status, escrow, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'paying', ?, ?, ?)`,
        )
        .run(
          j.quoteKey,
          j.task,
          j.buyer,
          json(j.request),
          json(j.payment),
          j.escrow ? json(j.escrow) : null,
          now,
          now,
        );
      return r.changes === 1;
    },

    job(quoteKey: string): Job | null {
      const r = db.prepare("SELECT * FROM jobs WHERE quote_key = ?").get(quoteKey);
      return r ? toJob(r) : null;
    },

    update(
      quoteKey: string,
      patch: Partial<Pick<Job, "status" | "paymentTx" | "result" | "error" | "refund" | "escrow">>,
    ) {
      const cols: Record<string, string | null> = {};
      if (patch.status) cols.status = patch.status;
      if (patch.paymentTx) cols.payment_tx = patch.paymentTx;
      if ("result" in patch) cols.result = json(patch.result ?? null);
      if (patch.error) cols.error = patch.error;
      if (patch.refund) cols.refund = json(patch.refund);
      if (patch.escrow) cols.escrow = json(patch.escrow);
      const keys = Object.keys(cols);
      db.prepare(
        `UPDATE jobs SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE quote_key = ?`,
      ).run(...keys.map((k) => cols[k] ?? null), Date.now(), quoteKey);
    },

    /** The payment never happened (refused, cancelled, expired): free the quote again. */
    release(quoteKey: string) {
      db.prepare("DELETE FROM jobs WHERE quote_key = ? AND status = 'paying'").run(quoteKey);
    },

    /** Jobs not finished yet: what a restart has to pick up. */
    unfinished(): Job[] {
      return db
        .prepare("SELECT * FROM jobs WHERE status IN ('paying', 'working')")
        .all()
        .map(toJob);
    },

    /** Escrowed fees still open on our side: done or failed jobs whose escrow hasn't closed. */
    openEscrows(): Job[] {
      return db
        .prepare(
          `SELECT * FROM jobs WHERE escrow IS NOT NULL AND status IN ('delivered', 'failed')
           AND json_extract(escrow, '$.closed') IS NULL`,
        )
        .all()
        .map(toJob);
    },

    close: () => db.close(),
  };
}

export type JobStore = ReturnType<typeof jobStore>;
