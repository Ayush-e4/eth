import {
  type Address,
  createPublicClient,
  createWalletClient,
  type Hex,
  http,
  type LocalAccount,
  type PublicClient,
} from "viem";
import { ESCROW_STATES, type EscrowState, mandateRegistryAbi } from "./abi";
import { hederaTestnet } from "./chain";

type Action =
  | "markDelivered"
  | "release"
  | "claim"
  | "dispute"
  | "refund"
  | "reclaim"
  | "associate";

/**
 * Pay on delivery, from the outside: read an escrow, and the moves each side can make. Every
 * write is simulated first, so a move that isn't allowed fails with the contract's error name.
 */
export class EscrowClient {
  readonly publicClient: PublicClient;

  constructor(
    readonly registry: Address,
    readonly chain = hederaTestnet,
  ) {
    this.publicClient = createPublicClient({ chain, transport: http() }) as PublicClient;
  }

  async get(id: Hex) {
    const e = await this.publicClient.readContract({
      address: this.registry,
      abi: mandateRegistryAbi,
      functionName: "getEscrow",
      args: [id],
    });
    return { ...e, state: (ESCROW_STATES[e.state] ?? "none") as EscrowState };
  }

  /** The payee: done, here's a hash of what was delivered. */
  markDelivered = (payee: LocalAccount, id: Hex, resultHash: Hex) =>
    this.write(payee, "markDelivered", [id, resultHash]);
  /** The buyer (mandate agent or owner): pay it out now. */
  release = (buyer: LocalAccount, id: Hex) => this.write(buyer, "release", [id]);
  /** Anyone, once delivered and the review window has passed. */
  claim = (sender: LocalAccount, id: Hex) => this.write(sender, "claim", [id]);
  /** The buyer objects, within the review window. */
  dispute = (buyer: LocalAccount, id: Hex) => this.write(buyer, "dispute", [id]);
  /** The payee gives it back. */
  refund = (payee: LocalAccount, id: Hex) => this.write(payee, "refund", [id]);
  /** Anyone, if it wasn't delivered by the deadline. */
  reclaim = (sender: LocalAccount, id: Hex) => this.write(sender, "reclaim", [id]);
  /** Hedera: let the registry hold this token (once per token). */
  associate = (sender: LocalAccount, token: Address) => this.write(sender, "associate", [token]);

  private async write(account: LocalAccount, functionName: Action, args: readonly unknown[]) {
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
}
