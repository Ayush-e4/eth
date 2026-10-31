import type { LocalAccount } from "viem";
import { signedHeaders } from "../auth";

/** A job as the agent reports it (GET /jobs/:quoteKey; see specialists/work.ts). */
export interface JobView {
  job: string;
  status: "paying" | "working" | "delivered" | "failed";
  agent: string;
  payTo: string; // the agent's Hedera account
  paymentTx?: string;
  result?: unknown;
  error?: string;
  detail?: string;
  refund?: { transaction?: string; failed?: string };
}

/** The agent said no, or took the fee and couldn't deliver (the message says if it refunded). */
export class HireFailed extends Error {}

/** Paid, or maybe paid, and the agent hasn't finished yet: read the job back later. */
export class HirePending extends Error {
  constructor(
    readonly endpoint: string,
    readonly quoteKey: string,
    readonly last: JobView | null,
  ) {
    super(
      `the agent hasn't finished yet (job ${last?.status ?? "unknown"}); it can be read back later`,
    );
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Reads our job from the agent, signed with the key that signed /work. Null if it has none. */
export async function readJob(
  endpoint: string,
  quoteKey: string,
  signer: LocalAccount,
  fetchImpl: typeof fetch = fetch,
): Promise<JobView | null> {
  const url = `${endpoint}/jobs/${quoteKey}`;
  const res = await fetchImpl(url, {
    headers: await signedHeaders(signer, "GET", new URL(url).pathname, ""),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`job read → HTTP ${res.status}`);
  return (await res.json()) as JobView;
}

/** Polls the job until it's delivered or failed, or time runs out (returns the last view). */
export async function awaitJob(
  endpoint: string,
  quoteKey: string,
  signer: LocalAccount,
  o: { timeoutMs?: number; everyMs?: number; wait?: typeof sleep; fetchImpl?: typeof fetch } = {},
): Promise<JobView | null> {
  const end = Date.now() + (o.timeoutMs ?? 120_000);
  const wait = o.wait ?? sleep;
  let last: JobView | null = null;
  for (;;) {
    last = await readJob(endpoint, quoteKey, signer, o.fetchImpl).catch(() => last);
    if (last && (last.status === "delivered" || last.status === "failed")) return last;
    if (Date.now() >= end) return last;
    await wait(o.everyMs ?? 3000);
  }
}
