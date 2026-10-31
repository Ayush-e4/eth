import {
  type Address,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  http,
  type LocalAccount,
  type PublicClient,
  parseAbi,
} from "viem";
import { hederaTestnet } from "./chain";

/**
 * ERC-8004 "Trustless Agents" on Hedera testnet: the shared, official registries, not ours.
 * An agent's identity is an ERC-721 token (its agentId) whose URI is its registration file;
 * reputation is feedback that clients who paid it leave on-chain.
 * Web2 analogy: a public business registry entry plus verified customer reviews.
 */
export const ERC8004 = {
  identity: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  reputation: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
} as const satisfies Record<string, Address>;

/** How other apps name our registry: `{namespace}:{chainId}:{identityRegistry}`. */
export const AGENT_REGISTRY = `eip155:${hederaTestnet.id}:${ERC8004.identity}`;

export const identityAbi = parseAbi([
  "function register(string agentURI) returns (uint256 agentId)",
  "function setAgentURI(uint256 agentId, string newURI)",
  "function tokenURI(uint256 agentId) view returns (string)",
  "function ownerOf(uint256 agentId) view returns (address)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
]);

export const reputationAbi = parseAbi([
  "function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
  "function getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)",
]);

export interface RegistrationInput {
  agentId?: bigint; // known after the first register()
  name: string;
  description: string;
  endpoint: string; // the agent's HTTP service (x402)
  arkivProfile?: string; // explorer link to its Arkiv profile entity
  hederaAccount: string; // where it gets paid
}

/** The ERC-8004 registration file (registration-v1). */
export function registrationFile(a: RegistrationInput) {
  return {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: a.name,
    description: a.description,
    services: [
      { name: "web", endpoint: a.endpoint },
      ...(a.arkivProfile ? [{ name: "arkiv", endpoint: a.arkivProfile }] : []),
      { name: "hedera", endpoint: `hedera:testnet:${a.hederaAccount}` },
    ],
    x402Support: true,
    active: true,
    registrations:
      a.agentId === undefined
        ? []
        : [{ agentId: Number(a.agentId), agentRegistry: AGENT_REGISTRY }],
    supportedTrust: ["reputation"],
  };
}

/** Fully on-chain: the file itself is the URI, so there's no host to go down. */
export const dataUri = (json: object) =>
  `data:application/json;base64,${Buffer.from(JSON.stringify(json)).toString("base64")}`;

/** Reads and writes against the shared ERC-8004 registries. */
export class Erc8004Client {
  readonly publicClient: PublicClient;

  constructor(readonly chain = hederaTestnet) {
    this.publicClient = createPublicClient({ chain, transport: http() });
  }

  private async write(
    account: LocalAccount,
    address: Address,
    abi: typeof identityAbi | typeof reputationAbi,
    functionName: string,
    args: readonly unknown[],
  ) {
    const { request } = await this.publicClient.simulateContract({
      account,
      address,
      abi,
      functionName,
      args,
    } as never);
    const wallet = createWalletClient({ account, chain: this.chain, transport: http() });
    const hash = await wallet.writeContract(request as never);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted: ${hash}`);
    return receipt;
  }

  /** The agent registers itself (it becomes the token's owner). Returns its agentId. */
  async register(agent: LocalAccount, agentURI: string) {
    const receipt = await this.write(agent, ERC8004.identity, identityAbi, "register", [agentURI]);
    for (const log of receipt.logs) {
      try {
        const ev = decodeEventLog({ abi: identityAbi, data: log.data, topics: log.topics });
        if (ev.eventName === "Registered") return { agentId: ev.args.agentId, receipt };
      } catch {}
    }
    throw new Error("Registered event not found");
  }

  setAgentURI(agent: LocalAccount, agentId: bigint, agentURI: string) {
    return this.write(agent, ERC8004.identity, identityAbi, "setAgentURI", [agentId, agentURI]);
  }

  ownerOf(agentId: bigint) {
    return this.publicClient.readContract({
      address: ERC8004.identity,
      abi: identityAbi,
      functionName: "ownerOf",
      args: [agentId],
    });
  }

  /** A client that paid the agent rates the job (the owner itself can't). Score 0–100. */
  giveFeedback(
    client: LocalAccount,
    agentId: bigint,
    score: number,
    skill: string,
    endpoint: string,
  ) {
    return this.write(client, ERC8004.reputation, reputationAbi, "giveFeedback", [
      agentId,
      BigInt(score),
      0,
      skill,
      "hired",
      endpoint,
      "",
      `0x${"00".repeat(32)}`,
    ]);
  }

  /** Feedback from the given clients only (the registry refuses an unfiltered summary). */
  async summary(agentId: bigint, clients: Address[]) {
    const [count, value] = await this.publicClient.readContract({
      address: ERC8004.reputation,
      abi: reputationAbi,
      functionName: "getSummary",
      args: [agentId, clients, "", ""],
    });
    return { count: Number(count), average: count ? Number(value) : null };
  }
}
