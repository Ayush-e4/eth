import { mandateRegistryAbi } from "@eth/mandates";
import { encodeAbiParameters, encodeFunctionData } from "viem";
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

describe("paymentScheduler.adopt (facilitator start)", () => {
  const OP = "0.0.2";
  const later = String(Math.floor(Date.now() / 1000) + 60);
  const s = (over: object) => ({
    schedule_id: "0.0.800",
    creator_account_id: OP,
    memo: "AgentNet payment, undo window",
    deleted: false,
    executed_timestamp: null,
    expiration_time: later,
    ...over,
  });
  const call = (mandateId: bigint) => ({
    contractId: "0.0.11102395",
    scheduledTxId: "0.0.2@1.2?scheduled",
    data: encodeFunctionData({
      abi: mandateRegistryAbi,
      functionName: "executeTransfer",
      args: [
        "0x0000000000000000000000000000000000000001",
        "0x0000000000000000000000000000000000068cda",
        "0x0000000000000000000000000000000000000002",
        30_000n,
        encodeAbiParameters(
          [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes" }],
          [mandateId, 5n, 9n, "0x"],
        ),
      ],
    }),
  });

  it("takes back only our own pending undo-window payments, which can then still be cancelled", async () => {
    const deleted: string[] = [];
    const schedules = [
      s({}),
      s({ schedule_id: "0.0.801", deleted: true }),
      s({ schedule_id: "0.0.802", executed_timestamp: "1.2" }),
      s({ schedule_id: "0.0.803", memo: "something else" }),
      s({ schedule_id: "0.0.804", creator_account_id: "0.0.9" }),
      s({ schedule_id: "0.0.805", expiration_time: "1" }),
    ];
    const sched = paymentScheduler({
      hedera: {} as never,
      adminKey: {} as never,
      feePayerId: OP,
      mirrorUrl: "https://mirror",
      fetchImpl: (async () => Response.json({ schedules })) as unknown as typeof fetch,
      readSchedule: async () => call(44n),
      deleteSchedule: async (id) => {
        deleted.push(id);
      },
    });
    expect(await sched.adopt()).toEqual(["0.0.800"]);
    expect(sched.byId("0.0.800")).toMatchObject({
      mandateId: "44",
      executor: "0.0.11102395",
      status: "scheduled",
      scheduledTxId: "0.0.2@1.2?scheduled",
    });
    expect(deleted).toEqual([]); // adopted, not deleted: it still runs when its window ends
    expect(await sched.cancel("0.0.800")).toBe(true);
    expect(deleted).toEqual(["0.0.800"]);
  });

  it("skips a schedule that isn't a payment through the registry, and an unreadable mirror", async () => {
    const odd = paymentScheduler({
      hedera: {} as never,
      adminKey: {} as never,
      feePayerId: OP,
      mirrorUrl: "https://mirror",
      fetchImpl: (async () => Response.json({ schedules: [s({})] })) as unknown as typeof fetch,
      readSchedule: async () => ({ contractId: "0.0.1", data: "0x1234", scheduledTxId: "" }),
    });
    expect(await odd.adopt()).toEqual([]);
    const down = paymentScheduler({
      hedera: {} as never,
      adminKey: {} as never,
      feePayerId: OP,
      mirrorUrl: "https://mirror",
      fetchImpl: (async () => new Response("", { status: 503 })) as unknown as typeof fetch,
    });
    expect(await down.adopt()).toEqual([]);
  });
});
