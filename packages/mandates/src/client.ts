import {
  type Address,
  BaseError,
  type Chain,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  type Hex,
  http,
  type LocalAccount,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { erc20Abi, mandateRegistryAbi } from "./abi";
import { mandateDomain, type PaymentAuth, type SubMandateAuth } from "./signing";

export interface MandateParams {
  agent: Address;
  token: Address;
  budget: bigint;
  perPaymentCap: bigint;
  expiresAt: bigint;
  payees: readonly Address[];
}

export type Mandate = Awaited<ReturnType<MandateClient["getMandate"]>>;

/** Thin typed wrapper around a deployed MandateRegistry. */
export class MandateClient {
  readonly publicClient: PublicClient;

  constructor(
    readonly registry: Address,
    readonly chain: Chain,
  ) {
    this.publicClient = createPublicClient({ chain, transport: http() });
  }

  domain() {
    return mandateDomain(this.chain.id, this.registry);
  }

  // ─── Reads ──────────────────────────────────────────────────────────

  getMandate(id: bigint) {
    return this.read("getMandate", [id]);
  }

  remaining(id: bigint) {
    return this.read("remaining", [id]);
  }

  isActive(id: bigint) {
    return this.read("isActive", [id]);
  }

  allowance(token: Address, owner: Address) {
    return this.publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [owner, this.registry],
    });
  }

  // ─── Writes (each simulated first, so rule violations surface as named errors) ───

  /** Owner lets the registry pull up to `amount` of `token`. */
  async approve(owner: LocalAccount, token: Address, amount: bigint) {
    const wallet = createWalletClient({ account: owner, chain: this.chain, transport: http() });
    const hash = await wallet.writeContract({
      address: token,
      abi: erc20Abi,
      functionName: "approve",
      args: [this.registry, amount],
    });
    return this.publicClient.waitForTransactionReceipt({ hash });
  }

  async createMandate(owner: LocalAccount, p: MandateParams) {
    const receipt = await this.write(owner, "createMandate", [{ ...p, payees: [...p.payees] }]);
    return { id: this.createdId(receipt), receipt };
  }

  async createSubMandate(
    sender: LocalAccount,
    auth: SubMandateAuth,
    payees: readonly Address[],
    signature: Hex,
  ) {
    const receipt = await this.write(sender, "createSubMandate", [auth, [...payees], signature]);
    return { id: this.createdId(receipt), receipt };
  }

  /** Submits an agent-signed payment. `sender` only pays gas (any relayer works). */
  pay(sender: LocalAccount, auth: PaymentAuth, signature: Hex) {
    return this.write(sender, "pay", [auth, signature]);
  }

  revoke(sender: LocalAccount, id: bigint) {
    return this.write(sender, "revoke", [id]);
  }

  /** Dry-runs a payment. Returns the contract's error name (e.g. "OverBudget") or null if it would succeed. */
  async checkPay(sender: Address, auth: PaymentAuth, signature: Hex): Promise<string | null> {
    try {
      await this.publicClient.simulateContract({
        account: sender,
        address: this.registry,
        abi: mandateRegistryAbi,
        functionName: "pay",
        args: [auth, signature],
      });
      return null;
    } catch (err) {
      return revertName(err);
    }
  }

  // ─── Internals ──────────────────────────────────────────────────────

  private read<F extends "getMandate" | "remaining" | "isActive">(fn: F, args: readonly [bigint]) {
    return this.publicClient.readContract({
      address: this.registry,
      abi: mandateRegistryAbi,
      functionName: fn,
      args,
    } as never) as Promise<
      F extends "getMandate"
        ? {
            owner: Address;
            agent: Address;
            token: Address;
            parentId: bigint;
            budget: bigint;
            spent: bigint;
            delegated: bigint;
            perPaymentCap: bigint;
            expiresAt: bigint;
            depth: number;
            revoked: boolean;
            restrictPayees: boolean;
          }
        : F extends "remaining"
          ? bigint
          : boolean
    >;
  }

  private async write(
    account: LocalAccount,
    functionName: "createMandate" | "createSubMandate" | "pay" | "revoke",
    args: readonly unknown[],
  ): Promise<TransactionReceipt> {
    const { request } = await this.publicClient.simulateContract({
      account,
      address: this.registry,
      abi: mandateRegistryAbi,
      functionName,
      args,
    } as never);
    const wallet = createWalletClient({ account, chain: this.chain, transport: http() });
    const hash = await wallet.writeContract(request as never);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted: ${hash}`);
    return receipt;
  }

  private createdId(receipt: TransactionReceipt): bigint {
    for (const log of receipt.logs) {
      try {
        const ev = decodeEventLog({ abi: mandateRegistryAbi, data: log.data, topics: log.topics });
        if (ev.eventName === "MandateCreated") return ev.args.id;
      } catch {}
    }
    throw new Error("MandateCreated event not found");
  }
}

/** Extracts a custom error name like "OverBudget" from a viem error. */
export function revertName(err: unknown): string {
  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      return reverted.data?.errorName ?? reverted.reason ?? "Reverted";
    }
    return err.shortMessage;
  }
  return String(err);
}
