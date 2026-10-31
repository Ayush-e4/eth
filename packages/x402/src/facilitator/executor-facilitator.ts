import { mandateRegistryAbi, revertName } from "@eth/mandates";
import { type Client, ContractExecuteTransaction } from "@hiero-ledger/sdk";
import type { SettleResponse, VerifyResponse } from "@x402/core/types";
import {
  decodeAbiParameters,
  encodeFunctionData,
  type Hex,
  type PublicClient,
  recoverMessageAddress,
} from "viem";
import { checkSettlement, type MirrorTx } from "../record-checks";
import { assetToEvm, longZero, type MirrorResolver } from "../resolve";
import {
  cancelMessage,
  ERR,
  type HederaCaip,
  type PaymentPayload,
  type PaymentRequirements,
  paymentKey,
  SCHEME,
  TRANSFER_EXECUTOR,
  UNDO_EXTENSION,
  UndoWindowSchema,
  X402_VERSION,
} from "../types";
import type { PaymentScheduler } from "./scheduled";
import { validateExecutorPayment } from "./validate";

export interface ExecutorFacilitatorDeps {
  network: HederaCaip;
  admittedExecutors: readonly string[]; // Hedera contract ids, e.g. MandateRegistry
  feePayerId: string; // our operator account (pays network fees)
  feePayerEvm: `0x${string}`;
  gas: bigint; // the limit we simulate with AND submit with
  hedera: Client;
  evm: PublicClient; // JSON-RPC (Hashio) for simulation
  mirror: MirrorResolver;
  fetchRecords: (transactionId: string) => Promise<MirrorTx[]>;
  onSettled?: (info: SettledInfo) => Promise<void>;
  /** Payments that ask for an undo window are scheduled on Hedera (see scheduled.ts). */
  scheduler?: PaymentScheduler;
  onScheduled?: (info: {
    scheduleId: string;
    mandateId: string;
    payTo: string;
    amount: string;
    executesAt: number;
  }) => Promise<void>;
}

const mandateOf = (authorization: Hex) =>
  decodeAbiParameters(
    [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes" }],
    authorization,
  )[0].toString();

export interface SettledInfo {
  transaction: string;
  payer: string;
  payTo: string;
  asset: string;
  amount: string;
  executor: string;
  authorization: Hex;
}

/**
 * x402 facilitator for Hedera `exact` + `transferExecutor` (spec Phases 3–4).
 * Verification = validation + admission + address resolution + simulation.
 * Settlement = ContractExecuteTransaction + proof from the mirror records.
 */
export class ExecutorFacilitator {
  private readonly inFlight = new Set<string>();

  constructor(private readonly d: ExecutorFacilitatorDeps) {}

  supported() {
    return {
      kinds: [
        {
          x402Version: X402_VERSION,
          scheme: SCHEME,
          network: this.d.network,
          extra: {
            feePayer: this.d.feePayerId,
            assetTransferMethods: [TRANSFER_EXECUTOR],
            executors: [...this.d.admittedExecutors],
          },
        },
      ],
    };
  }

  async verify(p: PaymentPayload, req: PaymentRequirements): Promise<VerifyResponse> {
    const prepared = await this.prepare(p, req);
    if (!prepared.ok) return prepared.invalid;
    return { isValid: true, payer: prepared.payer };
  }

  async settle(p: PaymentPayload, req: PaymentRequirements): Promise<SettleResponse> {
    const base = { transaction: "", network: this.d.network } as const;
    const prepared = await this.prepare(p, req);
    if (!prepared.ok) {
      const { invalidReason, invalidMessage } = prepared.invalid;
      return { ...base, success: false, errorReason: invalidReason, errorMessage: invalidMessage };
    }
    const { key, executor, data, payer, authorization } = prepared;
    if (this.inFlight.has(key)) {
      return { ...base, success: false, errorReason: ERR.duplicateInFlight, payer };
    }
    this.inFlight.add(key);
    try {
      const undo = UndoWindowSchema.safeParse(p.extensions?.[UNDO_EXTENSION]);
      let transaction: string;
      if (undo.success && this.d.scheduler) {
        // Undo window: Hedera runs the same call when it ends, unless it's cancelled first.
        const pending = await this.d.scheduler.create({
          key,
          executor,
          gas: this.d.gas,
          data,
          seconds: undo.data.seconds,
          mandateId: mandateOf(authorization),
        });
        await this.d.onScheduled?.({
          scheduleId: pending.scheduleId,
          mandateId: pending.mandateId,
          payTo: req.payTo,
          amount: req.amount,
          executesAt: pending.executesAt,
        });
        const outcome = await this.d.scheduler.outcome(pending);
        if (outcome !== "executed") {
          const cancelled = outcome === "cancelled";
          return {
            ...base,
            payer,
            success: false,
            errorReason: cancelled ? ERR.paymentCancelled : ERR.scheduleNotRun,
            errorMessage: cancelled
              ? `cancelled in the undo window (schedule ${pending.scheduleId}); nothing was paid`
              : `the scheduled payment ${pending.scheduleId} didn't run`,
          };
        }
        transaction = pending.scheduledTxId;
      } else {
        const res = await new ContractExecuteTransaction()
          .setContractId(executor)
          .setGas(Number(this.d.gas))
          .setFunctionParameters(Buffer.from(data.slice(2), "hex"))
          .execute(this.d.hedera);
        transaction = res.transactionId.toString();
        await res.getReceipt(this.d.hedera).catch(() => undefined); // record check is the real proof
      }

      const records = await this.d.fetchRecords(transaction);
      const verdict = checkSettlement(records, {
        payer,
        payTo: req.payTo,
        asset: req.asset,
        amount: BigInt(req.amount),
        feePayer: this.d.feePayerId,
      });
      if (!verdict.ok) {
        return {
          ...base,
          transaction,
          payer,
          success: false,
          errorReason: verdict.reason,
          errorMessage: verdict.detail,
        };
      }
      await this.d.onSettled?.({
        transaction,
        payer,
        payTo: req.payTo,
        asset: req.asset,
        amount: req.amount,
        executor,
        authorization,
      });
      return { ...base, transaction, payer, success: true, amount: req.amount };
    } catch (err) {
      return {
        ...base,
        payer,
        success: false,
        errorReason: ERR.unexpectedSettle,
        errorMessage: String(err),
      };
    } finally {
      this.inFlight.delete(key);
    }
  }

  /** Validate, resolve addresses, build the call ourselves, and simulate it. */
  private async prepare(p: PaymentPayload, req: PaymentRequirements) {
    const v = validateExecutorPayment(p, req, {
      network: this.d.network,
      admittedExecutors: this.d.admittedExecutors,
    });
    if (!v.isValid) return { ok: false as const, invalid: v };
    const { payer, executor, authorization } = v.payload;

    if (await this.d.mirror.hasCustomFees(req.asset).catch(() => true)) {
      return this.fail(
        ERR.customFeeAsset,
        `asset ${req.asset} has custom fees (or could not be checked)`,
        payer,
      );
    }
    let from: `0x${string}`;
    let to: `0x${string}`;
    try {
      [from, to] = await Promise.all([
        this.d.mirror.accountToEvm(payer),
        this.d.mirror.accountToEvm(req.payTo),
      ]);
    } catch (err) {
      return this.fail(ERR.addressResolution, String(err), payer);
    }

    // Built only from the requirements and payload.payer — never client-supplied calldata.
    const args = [
      from,
      assetToEvm(req.asset),
      to,
      BigInt(req.amount),
      authorization as Hex,
    ] as const;
    const data = encodeFunctionData({
      abi: mandateRegistryAbi,
      functionName: "executeTransfer",
      args,
    });
    try {
      // Same call, same gas limit as settlement; viem decodes the registry's custom errors.
      await this.d.evm.simulateContract({
        account: this.d.feePayerEvm,
        address: longZero(executor),
        abi: mandateRegistryAbi,
        functionName: "executeTransfer",
        args,
        gas: this.d.gas,
      });
    } catch (err) {
      return this.fail(ERR.simulationReverted, revertName(err), payer);
    }
    const key = paymentKey(this.d.network, executor, payer, authorization);
    return { ok: true as const, key, executor, data, payer, authorization: authorization as Hex };
  }

  /** A payment waiting out its undo window, by payment key. */
  scheduled(key: string) {
    return this.d.scheduler?.byKey(key) ?? null;
  }

  /**
   * Cancel a payment in its undo window. Only the mandate's agent (who signed the payment) may:
   * it signs `cancelMessage(scheduleId)`, and we check that against the mandate on-chain.
   */
  async cancelScheduled(
    scheduleId: string,
    signature: Hex,
  ): Promise<{ ok: boolean; reason?: string }> {
    const p = this.d.scheduler?.byId(scheduleId);
    if (!p) return { ok: false, reason: "no such scheduled payment" };
    if (p.status !== "scheduled") return { ok: false, reason: `it's already ${p.status}` };
    const signer = await recoverMessageAddress({ message: cancelMessage(scheduleId), signature });
    const m = (await this.d.evm.readContract({
      address: longZero(p.executor),
      abi: mandateRegistryAbi,
      functionName: "getMandate",
      args: [BigInt(p.mandateId)],
    })) as { agent: string };
    if (m.agent.toLowerCase() !== signer.toLowerCase())
      return { ok: false, reason: "only the mandate's agent can cancel its payments" };
    const ok = await this.d.scheduler?.cancel(scheduleId);
    return ok ? { ok: true } : { ok: false, reason: "too late to cancel" };
  }

  private fail(invalidReason: string, invalidMessage: string, payer?: string) {
    return {
      ok: false as const,
      invalid: { isValid: false, invalidReason, invalidMessage, payer },
    };
  }
}
