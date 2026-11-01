import {
  type Address,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  type Hex,
  http,
  keccak256,
  type LocalAccount,
  type PublicClient,
  parseAbi,
  parseEventLogs,
} from "viem";
import { erc20Abi, mandateRegistryAbi } from "./abi";
import { hederaTestnet } from "./chain";
import type { MandateParams } from "./client";

/** Human-readable ABIs for PasskeyWallet and its factory (abi.test.ts checks them). */
export const passkeyWalletAbi = parseAbi([
  "struct Call { address to; uint256 value; bytes data; }",
  "struct Assertion { bytes32 r; bytes32 s; uint256 challengeIndex; uint256 typeIndex; bytes authenticatorData; string clientDataJSON; }",
  "function digest(Call[] calls, uint256 deadline) view returns (bytes32)",
  "function execute(Call[] calls, uint256 deadline, Assertion sig)",
  "function nonce() view returns (uint256)",
  "function qx() view returns (bytes32)",
  "function qy() view returns (bytes32)",
  "function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)",
  "event Executed(uint256 indexed nonce, bytes32 digest)",
  "error Expired()",
  "error BadSignature()",
  "error CallFailed(uint256 index, bytes reason)",
]);
/** v2: any of its passkeys (one per device) signs; a batch it signed adds or removes another. */
export const passkeyWalletV2Abi = parseAbi([
  "struct Call { address to; uint256 value; bytes data; }",
  "struct Assertion { bytes32 r; bytes32 s; uint256 challengeIndex; uint256 typeIndex; bytes authenticatorData; string clientDataJSON; }",
  "struct KeySig { bytes32 qx; bytes32 qy; Assertion sig; }",
  "function digest(Call[] calls, uint256 deadline) view returns (bytes32)",
  "function execute(Call[] calls, uint256 deadline, KeySig k)",
  "function addKey(bytes32 qx, bytes32 qy)",
  "function removeKey(bytes32 qx, bytes32 qy)",
  "function keyId(bytes32 qx, bytes32 qy) pure returns (bytes32)",
  "function isKey(bytes32 id) view returns (bool)",
  "function keyCount() view returns (uint256)",
  "function nonce() view returns (uint256)",
  "function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)",
  "event Executed(uint256 indexed nonce, bytes32 digest)",
  "event KeyAdded(bytes32 qx, bytes32 qy)",
  "event KeyRemoved(bytes32 qx, bytes32 qy)",
  "error Expired()",
  "error NotAKey()",
  "error BadSignature()",
  "error CallFailed(uint256 index, bytes reason)",
  "error OnlySelf()",
  "error LastKey()",
]);
/** Both factories (v1 and v2) have this interface. */
export const passkeyWalletFactoryAbi = parseAbi([
  "function create(bytes32 qx, bytes32 qy, address token) returns (address wallet)",
  "function addressOf(bytes32 qx, bytes32 qy) view returns (address)",
  "event WalletCreated(address indexed wallet, bytes32 qx, bytes32 qy)",
]);

export type WalletCall = { to: Address; value: bigint; data: Hex };
export type PasskeyKey = { qx: Hex; qy: Hex };
export type Assertion = {
  r: Hex;
  s: Hex;
  challengeIndex: bigint;
  typeIndex: bigint;
  authenticatorData: Hex;
  clientDataJSON: string;
};
/** v2 wallets: which of its passkeys signed, with its answer. */
export type KeySig = PasskeyKey & { sig: Assertion };

const N = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
const fromB64url = (s: string) => Buffer.from(s, "base64url");
const hex32 = (b: Uint8Array) => `0x${Buffer.from(b).toString("hex").padStart(64, "0")}` as Hex;

/**
 * A browser's passkey answer (the base64url fields of `startAuthentication`'s response) in the
 * shape the wallet checks: r and s out of the DER signature (s flipped low, as the contract
 * requires), and where "type" and "challenge" sit in the client JSON.
 */
export function assertionFromWebAuthn(r: {
  authenticatorData: string;
  clientDataJSON: string;
  signature: string;
}): Assertion {
  const der = fromB64url(r.signature);
  const rLen = der[3] ?? 0;
  const rBytes = der.subarray(4, 4 + rLen);
  const sBytes = der.subarray(6 + rLen, 6 + rLen + (der[5 + rLen] ?? 0));
  const sig = (b: Uint8Array) => BigInt(`0x${Buffer.from(b).toString("hex") || "0"}`);
  let s = sig(sBytes);
  if (s > N / BigInt(2)) s = N - s;
  const client = fromB64url(r.clientDataJSON).toString("utf8");
  return {
    r: hex32(Buffer.from(sig(rBytes).toString(16).padStart(64, "0"), "hex")),
    s: hex32(Buffer.from(s.toString(16).padStart(64, "0"), "hex")),
    challengeIndex: BigInt(client.indexOf('"challenge":"')),
    typeIndex: BigInt(client.indexOf('"type":"webauthn.get"')),
    authenticatorData: `0x${fromB64url(r.authenticatorData).toString("hex")}`,
    clientDataJSON: client,
  };
}

/** The batch that sets a spending limit: let the registry pull up to the budget, then create it. */
export function limitCalls(registry: Address, p: MandateParams): WalletCall[] {
  return [
    {
      to: p.token,
      value: BigInt(0),
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [registry, p.budget],
      }),
    },
    {
      to: registry,
      value: BigInt(0),
      data: encodeFunctionData({
        abi: mandateRegistryAbi,
        functionName: "createMandate",
        args: [p],
      }),
    },
  ];
}

/** The batch that cancels a spending limit. */
export const revokeCalls = (registry: Address, id: bigint): WalletCall[] => [
  {
    to: registry,
    value: BigInt(0),
    data: encodeFunctionData({ abi: mandateRegistryAbi, functionName: "revoke", args: [id] }),
  },
];

/** v2: the batch that lets another device's passkey use the wallet. */
export const addKeyCalls = (wallet: Address, k: PasskeyKey): WalletCall[] => [
  {
    to: wallet,
    value: BigInt(0),
    data: encodeFunctionData({
      abi: passkeyWalletV2Abi,
      functionName: "addKey",
      args: [k.qx, k.qy],
    }),
  },
];

/** v2: the batch that shuts a device's passkey out (a lost phone). Never the last one. */
export const removeKeyCalls = (wallet: Address, k: PasskeyKey): WalletCall[] => [
  {
    to: wallet,
    value: BigInt(0),
    data: encodeFunctionData({
      abi: passkeyWalletV2Abi,
      functionName: "removeKey",
      args: [k.qx, k.qy],
    }),
  },
];

/**
 * Passkey wallets from the outside: where a passkey's wallet is, making it, and running a batch
 * the passkey signed. Whoever sends (our server) pays the gas; only the passkey decides.
 */
export class PasskeyWalletClient {
  readonly publicClient: PublicClient;

  constructor(
    readonly factory: Address,
    readonly chain = hederaTestnet,
  ) {
    this.publicClient = createPublicClient({ chain, transport: http() }) as PublicClient;
  }

  addressOf = (k: PasskeyKey) =>
    this.publicClient.readContract({
      address: this.factory,
      abi: passkeyWalletFactoryAbi,
      functionName: "addressOf",
      args: [k.qx, k.qy],
    });

  /** Makes the passkey's wallet (once) and opts it in to `token`. Returns its address. */
  async create(sender: LocalAccount, k: PasskeyKey, token: Address): Promise<Address> {
    const wallet = await this.addressOf(k);
    const code = await this.publicClient.getCode({ address: wallet });
    if (code && code !== "0x") return wallet;
    const hash = await createWalletClient({
      account: sender,
      chain: this.chain,
      transport: http(),
    }).writeContract({
      address: this.factory,
      abi: passkeyWalletFactoryAbi,
      functionName: "create",
      args: [k.qx, k.qy, token],
      gas: BigInt(3_000_000),
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`creating the wallet failed: ${hash}`);
    return wallet;
  }

  /** v2: whether this passkey may sign for the wallet. */
  hasKey = async (wallet: Address, k: PasskeyKey) =>
    this.publicClient.readContract({
      address: wallet,
      abi: passkeyWalletV2Abi,
      functionName: "isKey",
      args: [
        keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [k.qx, k.qy])),
      ],
    });

  /** What the passkey signs (the WebAuthn challenge) to run `calls` before `deadline`. */
  digest = (wallet: Address, calls: WalletCall[], deadline: bigint) =>
    this.publicClient.readContract({
      address: wallet,
      abi: passkeyWalletAbi,
      functionName: "digest",
      args: [calls, deadline],
    });

  /**
   * Runs a signed batch: a v1 wallet takes the passkey's answer, a v2 wallet also which passkey
   * gave it (a KeySig). Simulated first, so a bad signature fails with its error name.
   */
  async execute(
    sender: LocalAccount,
    wallet: Address,
    calls: WalletCall[],
    deadline: bigint,
    sig: Assertion | KeySig,
    gas = BigInt(2_000_000), // a limit used 1.2M on Hedera (approve through HTS is dear); revoke 0.3M
  ) {
    const { request } = await this.publicClient.simulateContract({
      account: sender,
      address: wallet,
      abi: [...("sig" in sig ? passkeyWalletV2Abi : passkeyWalletAbi), ...mandateRegistryAbi],
      functionName: "execute",
      args: [calls, deadline, sig as never],
      gas,
    });
    const hash = await createWalletClient({
      account: sender,
      chain: this.chain,
      transport: http(),
    }).writeContract(request);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`the wallet's batch failed: ${hash}`);
    const created = parseEventLogs({
      abi: mandateRegistryAbi,
      logs: receipt.logs,
      eventName: "MandateCreated",
    })[0];
    return { hash, mandateId: created?.args.id };
  }
}
