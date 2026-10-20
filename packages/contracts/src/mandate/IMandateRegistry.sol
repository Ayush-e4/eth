// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Types, events and errors for MandateRegistry.
/// A mandate is a spending permission an owner gives an agent: a budget, a per-payment cap,
/// an expiry and (optionally) a list of allowed payees. Funds stay in the owner's account;
/// the registry pulls them via an ERC-20 allowance only when a payment satisfies every rule.
interface IMandateRegistry {
    /// Arguments for creating a root mandate (called by the owner).
    struct MandateParams {
        address agent; // key that signs payment authorisations
        address token; // e.g. USDC's EVM address
        uint128 budget; // max total the agent may spend or delegate
        uint128 perPaymentCap; // max for a single payment
        uint64 expiresAt; // unix seconds
        address[] payees; // allowed recipients; empty = any recipient
    }

    struct Mandate {
        address owner; // whose funds are spent (same for every mandate in a tree)
        address agent;
        address token;
        uint256 parentId; // 0 for a root mandate
        uint128 budget;
        uint128 spent; // paid out directly by this mandate
        uint128 delegated; // carved out into sub-mandates
        uint128 perPaymentCap;
        uint64 expiresAt;
        uint8 depth; // 0 for root
        bool revoked;
        bool restrictPayees;
    }

    /// What an agent signs to authorise one payment.
    struct PaymentAuth {
        uint256 mandateId;
        address payTo;
        uint256 amount;
        uint256 nonce;
        uint256 validBefore;
    }

    /// What a parent mandate's agent signs to create a sub-mandate for another agent.
    struct SubMandateAuth {
        uint256 parentId;
        address agent;
        uint128 budget;
        uint128 perPaymentCap;
        uint64 expiresAt;
        bytes32 payeesHash; // keccak256(abi.encodePacked(payees))
        uint256 nonce;
        uint256 validBefore;
    }

    event MandateCreated(
        uint256 indexed id,
        uint256 indexed parentId,
        address indexed owner,
        address agent,
        uint128 budget,
        uint128 perPaymentCap,
        uint64 expiresAt
    );
    event Paid(uint256 indexed mandateId, address indexed payTo, uint256 amount, uint256 nonce);
    event Revoked(uint256 indexed mandateId, address indexed by);

    error InvalidParams();
    error UnknownMandate();
    error MandateInactive(); // revoked or expired, itself or an ancestor
    error AuthExpired();
    error NonceUsed();
    error BadSignature();
    error OverPaymentCap();
    error OverBudget();
    error PayeeNotAllowed();
    error NotAuthorized();
    error TooDeep();
    error WrongOwnerOrAsset(); // x402 executeTransfer: from/asset don't match the mandate
}
