import {
  type Address,
  encodeAbiParameters,
  encodePacked,
  type Hex,
  keccak256,
  type LocalAccount,
} from "viem";

/** EIP-712 domain; must match `EIP712("MandateRegistry", "1")` in the contract. */
export function mandateDomain(chainId: number, registry: Address) {
  return { name: "MandateRegistry", version: "1", chainId, verifyingContract: registry } as const;
}

export const paymentAuthTypes = {
  PaymentAuth: [
    { name: "mandateId", type: "uint256" },
    { name: "payTo", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "validBefore", type: "uint256" },
  ],
} as const;

export const subMandateAuthTypes = {
  SubMandateAuth: [
    { name: "parentId", type: "uint256" },
    { name: "agent", type: "address" },
    { name: "budget", type: "uint128" },
    { name: "perPaymentCap", type: "uint128" },
    { name: "expiresAt", type: "uint64" },
    { name: "payeesHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "validBefore", type: "uint256" },
  ],
} as const;

export interface PaymentAuth {
  mandateId: bigint;
  payTo: Address;
  amount: bigint;
  nonce: bigint;
  validBefore: bigint;
}

export interface SubMandateAuth {
  parentId: bigint;
  agent: Address;
  budget: bigint;
  perPaymentCap: bigint;
  expiresAt: bigint;
  payeesHash: Hex;
  nonce: bigint;
  validBefore: bigint;
}

/** Same as `keccak256(abi.encodePacked(payees))` in Solidity. */
export function hashPayees(payees: readonly Address[]): Hex {
  return keccak256(encodePacked(["address[]"], [payees]));
}

/** Random 256-bit nonce, so concurrent agents never collide. */
export function randomNonce(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
}

export function signPaymentAuth(
  agent: LocalAccount,
  domain: ReturnType<typeof mandateDomain>,
  message: PaymentAuth,
): Promise<Hex> {
  return agent.signTypedData({
    domain,
    types: paymentAuthTypes,
    primaryType: "PaymentAuth",
    message,
  });
}

export function signSubMandateAuth(
  agent: LocalAccount,
  domain: ReturnType<typeof mandateDomain>,
  message: SubMandateAuth,
): Promise<Hex> {
  return agent.signTypedData({
    domain,
    types: subMandateAuthTypes,
    primaryType: "SubMandateAuth",
    message,
  });
}

/** The opaque `authorization` bytes x402's `executeTransfer` expects from our registry. */
export function encodeX402Authorization(auth: PaymentAuth, signature: Hex): Hex {
  return encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes" }],
    [auth.mandateId, auth.nonce, auth.validBefore, signature],
  );
}
