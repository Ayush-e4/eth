import { parseAbi } from "viem";

/**
 * Human-readable ABI for MandateRegistry. `abi.test.ts` checks it against the compiled
 * Foundry artifact so the two can't drift apart.
 */
export const mandateRegistryAbi = parseAbi([
  "struct MandateParams { address agent; address token; uint128 budget; uint128 perPaymentCap; uint64 expiresAt; address[] payees; }",
  "struct Mandate { address owner; address agent; address token; uint256 parentId; uint128 budget; uint128 spent; uint128 delegated; uint128 perPaymentCap; uint64 expiresAt; uint8 depth; bool revoked; bool restrictPayees; }",
  "struct PaymentAuth { uint256 mandateId; address payTo; uint256 amount; uint256 nonce; uint256 validBefore; }",
  "struct SubMandateAuth { uint256 parentId; address agent; uint128 budget; uint128 perPaymentCap; uint64 expiresAt; bytes32 payeesHash; uint256 nonce; uint256 validBefore; }",
  "struct EscrowAuth { uint256 mandateId; address payTo; uint256 amount; uint256 nonce; uint256 validBefore; uint64 deliverBy; uint32 reviewSeconds; }",
  "struct Escrow { uint256 mandateId; address payee; uint64 deliverBy; uint32 reviewSeconds; uint128 amount; uint64 deliveredAt; uint8 state; bytes32 resultHash; }",

  "function createMandate(MandateParams p) returns (uint256 id)",
  "function createSubMandate(SubMandateAuth a, address[] payees, bytes signature) returns (uint256 id)",
  "function pay(PaymentAuth a, bytes signature)",
  "function executeTransfer(address from, address asset, address to, uint256 amount, bytes authorization)",
  "function revoke(uint256 id)",
  "function executeEscrowTransfer(address from, address asset, address to, uint256 amount, bytes authorization) returns (bytes32)",
  "function payIntoEscrow(EscrowAuth a, bytes signature) returns (bytes32)",
  "function markDelivered(bytes32 id, bytes32 resultHash)",
  "function release(bytes32 id)",
  "function claim(bytes32 id)",
  "function dispute(bytes32 id)",
  "function refund(bytes32 id)",
  "function reclaim(bytes32 id)",
  "function associate(address token)",
  "function getEscrow(bytes32 id) view returns (Escrow)",
  "function escrowIdOf(uint256 mandateId, uint256 nonce) pure returns (bytes32)",
  "function escrowDigest(EscrowAuth a) view returns (bytes32)",

  "function getMandate(uint256 id) view returns (Mandate)",
  "function remaining(uint256 id) view returns (uint256)",
  "function isActive(uint256 id) view returns (bool)",
  "function isPayeeAllowed(uint256 id, address payee) view returns (bool)",
  "function nonceUsed(uint256 id, uint256 nonce) view returns (bool)",
  "function mandateCount() view returns (uint256)",
  "function paymentDigest(PaymentAuth a) view returns (bytes32)",
  "function subMandateDigest(SubMandateAuth a) view returns (bytes32)",

  "event MandateCreated(uint256 indexed id, uint256 indexed parentId, address indexed owner, address agent, uint128 budget, uint128 perPaymentCap, uint64 expiresAt)",
  "event Paid(uint256 indexed mandateId, address indexed payTo, uint256 amount, uint256 nonce)",
  "event Revoked(uint256 indexed mandateId, address indexed by)",
  "event Escrowed(bytes32 indexed id, uint256 indexed mandateId, address indexed payee, uint256 amount, uint64 deliverBy)",
  "event Delivered(bytes32 indexed id, bytes32 resultHash)",
  "event EscrowReleased(bytes32 indexed id, address indexed by)",
  "event EscrowRefunded(bytes32 indexed id, address indexed by)",
  "event EscrowDisputed(bytes32 indexed id)",
  "event EIP712DomainChanged()", // from OpenZeppelin EIP712 (EIP-5267)

  "error InvalidParams()",
  "error UnknownMandate()",
  "error MandateInactive()",
  "error AuthExpired()",
  "error NonceUsed()",
  "error BadSignature()",
  "error OverPaymentCap()",
  "error OverBudget()",
  "error PayeeNotAllowed()",
  "error NotAuthorized()",
  "error TooDeep()",
  "error WrongOwnerOrAsset()",
  "error UnknownEscrow()",
  "error WrongEscrowState()",
  "error TooEarly()",
  "error TooLate()",
  "error AssociationFailed(int64 code)",
]);

/** EscrowState in the contract, by its uint8 value. */
export const ESCROW_STATES = [
  "none",
  "held",
  "delivered",
  "disputed",
  "released",
  "refunded",
] as const;
export type EscrowState = (typeof ESCROW_STATES)[number];

export const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
]);
