import { decodeX402Authorization, mandateRegistryAbi } from "@eth/mandates";
import {
  AccountId,
  type Client,
  ContractExecuteTransaction,
  type PrivateKey,
  ScheduleCreateTransaction,
  ScheduleDeleteTransaction,
  ScheduleInfoQuery,
  Timestamp,
} from "@hiero-ledger/sdk";
import { decodeFunctionData, type Hex } from "viem";

/**
 * The undo window, natively on Hedera: instead of running a payment now, the facilitator
 * schedules it (ScheduleCreate wrapping the same ContractExecute) to run when the window ends.
 * Until then the schedule's admin key can delete it, and nothing is paid. Web2 analogy: a bank
 * transfer dated for later that you can still cancel; Hedera, not our server, keeps the timing.
 */
export type ScheduleStatus = "scheduled" | "executed" | "cancelled" | "failed";

export interface PendingPayment {
  key: string; // the facilitator's payment key (see paymentKey)
  scheduleId: string;
  scheduledTxId: string; // "0.0.x@123.456?scheduled": the payment's own transaction, once run
  executesAt: number; // ms
  mandateId: string;
  executor: string; // the contract the payment runs through (MandateRegistry)
  status: ScheduleStatus;
}

export interface SchedulerDeps {
  hedera: Client;
  adminKey: PrivateKey; // can delete a pending schedule (our operator key)
  feePayerId: string; // pays the scheduled transaction's fees
  mirrorUrl: string;
  fetchImpl?: typeof fetch;
  wait?: (ms: number) => Promise<void>;
  deleteSchedule?: (scheduleId: string) => Promise<void>; // tests replace the Hedera call
  /** What a schedule will run (tests replace the Hedera query). */
  readSchedule?: (scheduleId: string) => Promise<ScheduledCall | null>;
}

/** The contract call inside a schedule, as Hedera holds it. */
export interface ScheduledCall {
  contractId: string;
  data: Hex;
  scheduledTxId: string;
}

export const MIN_UNDO_S = 10;
export const MAX_UNDO_S = 600;
const MEMO = "AgentNet payment, undo window";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function paymentScheduler(d: SchedulerDeps) {
  const byKey = new Map<string, PendingPayment>();
  const byId = new Map<string, PendingPayment>();
  const wait = d.wait ?? sleep;
  const fetchImpl = d.fetchImpl ?? fetch;

  /** What the mirror node says about a schedule (it lags consensus by a few seconds). */
  async function mirrorState(scheduleId: string) {
    const res = await fetchImpl(`${d.mirrorUrl}/api/v1/schedules/${scheduleId}`).catch(() => null);
    if (!res?.ok) return null;
    const s = (await res.json()) as { deleted?: boolean; executed_timestamp?: string | null };
    return s.deleted ? "cancelled" : s.executed_timestamp ? "executed" : "scheduled";
  }

  /** Deletes a schedule with our admin key: it can never run. */
  async function deleteOnHedera(scheduleId: string) {
    const tx = await new ScheduleDeleteTransaction()
      .setScheduleId(scheduleId)
      .freezeWith(d.hedera)
      .sign(d.adminKey);
    await (await tx.execute(d.hedera)).getReceipt(d.hedera);
  }
  const remove = d.deleteSchedule ?? deleteOnHedera;

  async function readOnHedera(scheduleId: string): Promise<ScheduledCall | null> {
    const info = await new ScheduleInfoQuery().setScheduleId(scheduleId).execute(d.hedera);
    const tx = info.scheduledTransaction;
    if (!(tx instanceof ContractExecuteTransaction) || !tx.contractId || !tx.functionParameters)
      return null;
    return {
      contractId: tx.contractId.toString(),
      data: `0x${Buffer.from(tx.functionParameters).toString("hex")}`,
      scheduledTxId: info.scheduledTransactionId?.toString() ?? "",
    };
  }
  const readSchedule = d.readSchedule ?? readOnHedera;

  return {
    async create(args: {
      key: string;
      executor: string;
      gas: bigint;
      data: Hex;
      seconds: number;
      mandateId: string;
    }): Promise<PendingPayment> {
      const seconds = Math.min(MAX_UNDO_S, Math.max(MIN_UNDO_S, Math.round(args.seconds)));
      const executesAt = Date.now() + seconds * 1000;
      const call = new ContractExecuteTransaction()
        .setContractId(args.executor)
        .setGas(Number(args.gas))
        .setFunctionParameters(Buffer.from(args.data.slice(2), "hex"));
      const res = await new ScheduleCreateTransaction()
        .setScheduledTransaction(call)
        .setAdminKey(d.adminKey.publicKey)
        .setPayerAccountId(AccountId.fromString(d.feePayerId))
        .setExpirationTime(Timestamp.fromDate(new Date(executesAt)))
        .setWaitForExpiry(true)
        .setScheduleMemo(MEMO)
        .execute(d.hedera);
      const receipt = await res.getReceipt(d.hedera);
      if (!receipt.scheduleId || !receipt.scheduledTransactionId)
        throw new Error("ScheduleCreate returned no schedule");
      const p: PendingPayment = {
        key: args.key,
        scheduleId: receipt.scheduleId.toString(),
        scheduledTxId: receipt.scheduledTransactionId.toString(),
        executesAt,
        mandateId: args.mandateId,
        executor: args.executor,
        status: "scheduled",
      };
      byKey.set(p.key, p);
      byId.set(p.scheduleId, p);
      return p;
    },

    /** Waits for the window to end, then for the mirror to say whether it ran or was deleted. */
    async outcome(p: PendingPayment): Promise<ScheduleStatus> {
      await wait(Math.max(0, p.executesAt - Date.now()));
      for (let i = 0; i < 40 && p.status === "scheduled"; i++) {
        const s = await mirrorState(p.scheduleId);
        if (s && s !== "scheduled") p.status = s;
        else await wait(3000);
      }
      if (p.status === "scheduled") p.status = "failed"; // never seen to run: treat as not paid
      return p.status;
    },

    async cancel(scheduleId: string) {
      const p = byId.get(scheduleId);
      if (p?.status !== "scheduled") return false;
      await remove(scheduleId);
      p.status = "cancelled";
      return true;
    },

    /**
     * At startup: take back our undo-window payments still pending on Hedera, so they can still
     * be followed and cancelled. They run when their window ends whether or not we restarted:
     * the agent sees the payment on-chain and does the job (see agent-jobs.md). Returns their ids.
     */
    async adopt(): Promise<string[]> {
      const url = `${d.mirrorUrl}/api/v1/schedules?account.id=${d.feePayerId}&order=desc&limit=100`;
      const res = await fetchImpl(url).catch(() => null);
      if (!res?.ok) return [];
      const { schedules = [] } = (await res.json()) as {
        schedules?: {
          schedule_id: string;
          creator_account_id: string;
          memo: string;
          deleted: boolean;
          executed_timestamp: string | null;
          expiration_time: string | null;
        }[];
      };
      const adopted: string[] = [];
      for (const s of schedules) {
        const executesAt = Number(s.expiration_time ?? 0) * 1000;
        const ours = s.memo === MEMO && s.creator_account_id === d.feePayerId;
        if (!ours || s.deleted || s.executed_timestamp || executesAt <= Date.now()) continue;
        if (byId.has(s.schedule_id)) continue;
        const call = await readSchedule(s.schedule_id).catch(() => null);
        const mandateId = call && mandateOfCall(call.data);
        if (!call || mandateId === null) continue;
        const p: PendingPayment = {
          key: `adopted:${s.schedule_id}`, // the payment key needs the payer's Hedera id; not kept
          scheduleId: s.schedule_id,
          scheduledTxId: call.scheduledTxId,
          executesAt,
          mandateId,
          executor: call.contractId,
          status: "scheduled",
        };
        byId.set(p.scheduleId, p);
        byKey.set(p.key, p);
        adopted.push(p.scheduleId);
      }
      return adopted;
    },

    byKey: (key: string) => byKey.get(key) ?? null,
    byId: (id: string) => byId.get(id) ?? null,
  };
}

export type PaymentScheduler = ReturnType<typeof paymentScheduler>;

/** The mandate an executeTransfer call pays from (null if it isn't one). */
function mandateOfCall(data: Hex): string | null {
  try {
    const { functionName, args } = decodeFunctionData({ abi: mandateRegistryAbi, data });
    if (functionName !== "executeTransfer") return null;
    return decodeX402Authorization(args[4] as Hex).mandateId.toString();
  } catch {
    return null;
  }
}
