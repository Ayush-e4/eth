import {
  AccountId,
  type Client,
  ContractExecuteTransaction,
  type PrivateKey,
  ScheduleCreateTransaction,
  ScheduleDeleteTransaction,
  Timestamp,
} from "@hiero-ledger/sdk";
import type { Hex } from "viem";

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
     * At startup: our undo-window payments still pending on Hedera belong to a settle that died
     * with the last run, so the agent was told it failed and won't do the job. Delete them so
     * they can't pay for nothing. Returns the schedules deleted.
     */
    async sweep(): Promise<string[]> {
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
      const pending = schedules.filter(
        (s) =>
          s.memo === MEMO &&
          s.creator_account_id === d.feePayerId &&
          !s.deleted &&
          !s.executed_timestamp &&
          Number(s.expiration_time ?? 0) * 1000 > Date.now(),
      );
      const swept: string[] = [];
      for (const s of pending) {
        if (byId.has(s.schedule_id)) continue; // one of this run's own: someone is waiting on it
        await remove(s.schedule_id).then(
          () => swept.push(s.schedule_id),
          (err) => console.error(`couldn't delete schedule ${s.schedule_id}:`, err),
        );
      }
      return swept;
    },

    byKey: (key: string) => byKey.get(key) ?? null,
    byId: (id: string) => byId.get(id) ?? null,
  };
}

export type PaymentScheduler = ReturnType<typeof paymentScheduler>;
