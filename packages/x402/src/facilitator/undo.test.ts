import { encodeAbiParameters } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { cancelMessage, ERR, type PaymentPayload, type PaymentRequirements } from "../types";
import { ExecutorFacilitator, type ExecutorFacilitatorDeps } from "./executor-facilitator";
import { type PendingPayment, paymentScheduler } from "./scheduled";

const agent = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());
const noWait = async () => {};

const pending = (over: Partial<PendingPayment> = {}): PendingPayment => ({
  key: "0xkey",
  scheduleId: "0.0.700",
  scheduledTxId: "0.0.1@1.2?scheduled",
  executesAt: Date.now(),
  mandateId: "7",
  executor: "0.0.11102395",
  status: "scheduled",
  ...over,
});

/** A scheduler that never touches Hedera: create returns `p`, outcome returns `result`. */
function fakeScheduler(p: PendingPayment, result: PendingPayment["status"]) {
  const cancelled: string[] = [];
  return {
    cancelled,
    create: async () => p,
    outcome: async () => result,
    cancel: async (id: string) => {
      cancelled.push(id);
      p.status = "cancelled";
      return true;
    },
    byKey: (k: string) => (k === p.key ? p : null),
    byId: (id: string) => (id === p.scheduleId ? p : null),
  };
}

function facilitator(scheduler: ReturnType<typeof fakeScheduler>, mandateAgent = agent.address) {
  const scheduled: unknown[] = [];
  const f = new ExecutorFacilitator({
    network: "hedera:testnet",
    admittedExecutors: ["0.0.11102395"],
    feePayerId: "0.0.2",
    feePayerEvm: "0x0000000000000000000000000000000000000002",
    gas: 400_000n,
    hedera: {} as ExecutorFacilitatorDeps["hedera"],
    evm: { readContract: async () => ({ agent: mandateAgent }) } as never,
    mirror: {} as ExecutorFacilitatorDeps["mirror"],
    fetchRecords: async () => {
      throw new Error("no records expected on this path");
    },
    scheduler: scheduler as never,
    onScheduled: async (s) => {
      scheduled.push(s);
    },
  });
  // Skip the on-chain checks; settle's own undo branch is what's under test.
  const authorization = encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes" }],
    [7n, 1n, 2n, "0x"],
  );
  Object.assign(f, {
    prepare: async () => ({
      ok: true,
      key: "0xkey",
      executor: "0.0.11102395",
      data: "0x",
      payer: "0.0.1",
      authorization,
    }),
  });
  return { f, scheduled };
}

const req = { payTo: "0.0.9", amount: "50000", asset: "0.0.429274" } as PaymentRequirements;
const withUndo = { extensions: { undoWindow: { seconds: 30 } } } as unknown as PaymentPayload;

describe("undo window settle", () => {
  it("a payment cancelled in its window fails with nothing paid", async () => {
    const s = fakeScheduler(pending(), "cancelled");
    const { f, scheduled } = facilitator(s);
    const out = await f.settle(withUndo, req);
    expect(out).toMatchObject({ success: false, errorReason: ERR.paymentCancelled });
    expect(scheduled).toHaveLength(1);
  });

  it("a schedule that never ran fails as not paid", async () => {
    const { f } = facilitator(fakeScheduler(pending(), "failed"));
    expect(await f.settle(withUndo, req)).toMatchObject({ errorReason: ERR.scheduleNotRun });
  });

  it("only the mandate's agent can cancel", async () => {
    const s = fakeScheduler(pending(), "scheduled");
    const { f } = facilitator(s);
    const bad = await stranger.signMessage({ message: cancelMessage("0.0.700") });
    expect(await f.cancelScheduled("0.0.700", bad)).toMatchObject({ ok: false });
    expect(s.cancelled).toEqual([]);
    const good = await agent.signMessage({ message: cancelMessage("0.0.700") });
    expect(await f.cancelScheduled("0.0.700", good)).toEqual({ ok: true });
    expect(s.cancelled).toEqual(["0.0.700"]);
    // A second cancel finds it already cancelled.
    expect(await f.cancelScheduled("0.0.700", good)).toMatchObject({ ok: false });
  });
});

describe("paymentScheduler.outcome", () => {
  const mirror = (body: object) =>
    paymentScheduler({
      hedera: {} as never,
      adminKey: {} as never,
      feePayerId: "0.0.2",
      mirrorUrl: "https://mirror",
      fetchImpl: (async () => Response.json(body)) as unknown as typeof fetch,
      wait: noWait,
    });

  it("reads executed and deleted from the mirror", async () => {
    expect(await mirror({ executed_timestamp: "1.2" }).outcome(pending())).toBe("executed");
    expect(await mirror({ deleted: true }).outcome(pending())).toBe("cancelled");
  });

  it("treats a schedule that never shows as run as not paid", async () => {
    expect(await mirror({ executed_timestamp: null }).outcome(pending())).toBe("failed");
  });
});
