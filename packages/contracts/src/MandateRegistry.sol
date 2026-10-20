// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MandateSignatures} from "./mandate/MandateSignatures.sol";

/// @title MandateRegistry
/// @notice Onchain spending mandates for AI agents. An owner approves this contract to spend
///   their token (e.g. USDC) and creates mandates; agents then authorise individual payments
///   by signature. Every payment is checked here — signer, expiry, revocation (including
///   ancestors), single-use nonce, per-payment cap, budget, payee allowlist — before the
///   registry pulls exactly that amount from the owner to the payee.
/// @dev Funds never sit in this contract. Not upgradeable and no admin, so the rules cannot
///   change under users. Implements the x402 Hedera `transferExecutor` interface
///   (`executeTransfer`, selector 0xea8f19fd) so an x402 facilitator can settle through it.
contract MandateRegistry is MandateSignatures {
    using SafeERC20 for IERC20;

    /// Root is depth 0; sub-mandates can nest this deep.
    uint8 public constant MAX_DEPTH = 3;

    uint256 public mandateCount;
    mapping(uint256 id => Mandate) internal _mandates;
    mapping(uint256 id => mapping(address payee => bool)) public isPayeeAllowed;
    mapping(uint256 id => mapping(uint256 nonce => bool)) public nonceUsed;

    // ─── Create ─────────────────────────────────────────────────────────

    /// @notice Owner creates a root mandate for an agent. Funds stay with the owner.
    function createMandate(MandateParams calldata p) external returns (uint256 id) {
        if (
            p.agent == address(0) || p.token == address(0) || p.budget == 0 || p.perPaymentCap == 0
                || p.perPaymentCap > p.budget || p.expiresAt <= block.timestamp
        ) revert InvalidParams();

        Mandate memory m;
        m.owner = msg.sender;
        m.agent = p.agent;
        m.token = p.token;
        m.budget = p.budget;
        m.perPaymentCap = p.perPaymentCap;
        m.expiresAt = p.expiresAt;
        m.restrictPayees = p.payees.length > 0;
        id = _store(m, p.payees);
    }

    /// @notice Creates a sub-mandate, authorised by the parent mandate's agent's signature.
    ///   Its budget is carved out of the parent's remaining budget, and its limits can only be
    ///   tighter than the parent's (cap, expiry, payees).
    function createSubMandate(
        SubMandateAuth calldata a,
        address[] calldata payees,
        bytes calldata signature
    ) external returns (uint256 id) {
        Mandate storage parent = _requireActive(a.parentId);
        if (parent.depth >= MAX_DEPTH) revert TooDeep();
        if (keccak256(abi.encodePacked(payees)) != a.payeesHash) revert InvalidParams();
        _useNonce(a.parentId, a.nonce, a.validBefore);
        _requireSignedBy(parent.agent, subMandateDigest(a), signature);

        if (
            a.agent == address(0) || a.budget == 0 || a.perPaymentCap == 0
                || a.perPaymentCap > a.budget || a.perPaymentCap > parent.perPaymentCap
                || a.expiresAt <= block.timestamp || a.expiresAt > parent.expiresAt
        ) revert InvalidParams();
        if (a.budget > _remaining(parent)) revert OverBudget();
        if (parent.restrictPayees) {
            if (payees.length == 0) revert PayeeNotAllowed();
            for (uint256 i; i < payees.length; ++i) {
                if (!isPayeeAllowed[a.parentId][payees[i]]) revert PayeeNotAllowed();
            }
        }

        parent.delegated += a.budget;

        Mandate memory m;
        m.owner = parent.owner;
        m.agent = a.agent;
        m.token = parent.token;
        m.parentId = a.parentId;
        m.budget = a.budget;
        m.perPaymentCap = a.perPaymentCap;
        m.expiresAt = a.expiresAt;
        m.depth = parent.depth + 1;
        m.restrictPayees = payees.length > 0;
        id = _store(m, payees);
    }

    // ─── Pay ────────────────────────────────────────────────────────────

    /// @notice Settles one agent-signed payment. Anyone may submit it (e.g. our backend);
    ///   the signature is what authorises it.
    function pay(PaymentAuth calldata a, bytes calldata signature) external {
        _pay(a, signature);
    }

    /// @notice x402 Hedera `transferExecutor` entry point, called by an x402 facilitator.
    /// @param authorization abi.encode(mandateId, nonce, validBefore, signature) where
    ///   `signature` is the agent's EIP-712 PaymentAuth over (mandateId, to, amount, nonce,
    ///   validBefore). `from` and `asset` must be the mandate's owner and token, so the
    ///   authorization is bound to from, asset, to and amount as the spec requires.
    function executeTransfer(
        address from,
        address asset,
        address to,
        uint256 amount,
        bytes calldata authorization
    ) external {
        (uint256 mandateId, uint256 nonce, uint256 validBefore, bytes memory signature) =
            abi.decode(authorization, (uint256, uint256, uint256, bytes));
        Mandate storage m = _mandates[mandateId];
        if (m.owner != from || m.token != asset) revert WrongOwnerOrAsset();
        _pay(PaymentAuth(mandateId, to, amount, nonce, validBefore), signature);
    }

    function _pay(PaymentAuth memory a, bytes memory signature) internal {
        Mandate storage m = _requireActive(a.mandateId);
        _useNonce(a.mandateId, a.nonce, a.validBefore);
        _requireSignedBy(m.agent, paymentDigest(a), signature);

        if (a.amount == 0) revert InvalidParams();
        if (a.amount > m.perPaymentCap) revert OverPaymentCap();
        if (a.amount > _remaining(m)) revert OverBudget();
        if (m.restrictPayees && !isPayeeAllowed[a.mandateId][a.payTo]) revert PayeeNotAllowed();

        // Effects before the external call. amount <= perPaymentCap (uint128), so the cast is safe.
        // forge-lint: disable-next-line(unsafe-typecast)
        m.spent += uint128(a.amount);
        emit Paid(a.mandateId, a.payTo, a.amount, a.nonce);

        // `from` is the mandate owner, who approved this contract; every rule above bounds it.
        // forge-lint: disable-next-line(arbitrary-send-erc20)
        IERC20(m.token).safeTransferFrom(m.owner, a.payTo, a.amount);
    }

    // ─── Revoke ─────────────────────────────────────────────────────────

    /// @notice Stops a mandate and, because payments check every ancestor, all of its
    ///   sub-mandates too. Callable by the owner, the mandate's own agent, or the parent's agent.
    function revoke(uint256 id) external {
        Mandate storage m = _mandates[id];
        if (m.owner == address(0)) revert UnknownMandate();
        bool allowed = msg.sender == m.owner || msg.sender == m.agent
            || (m.parentId != 0 && msg.sender == _mandates[m.parentId].agent);
        if (!allowed) revert NotAuthorized();
        m.revoked = true;
        emit Revoked(id, msg.sender);
    }

    // ─── Views ──────────────────────────────────────────────────────────

    function getMandate(uint256 id) external view returns (Mandate memory) {
        return _mandates[id];
    }

    /// @notice Budget still available to spend or delegate.
    function remaining(uint256 id) external view returns (uint256) {
        return _remaining(_mandates[id]);
    }

    /// @notice False if this mandate or any ancestor is revoked or expired.
    function isActive(uint256 id) public view returns (bool) {
        if (_mandates[id].owner == address(0)) return false;
        for (uint256 cur = id; cur != 0; cur = _mandates[cur].parentId) {
            Mandate storage m = _mandates[cur];
            if (m.revoked || m.expiresAt <= block.timestamp) return false;
        }
        return true;
    }

    // ─── Internals ──────────────────────────────────────────────────────

    function _store(Mandate memory m, address[] calldata payees) internal returns (uint256 id) {
        id = ++mandateCount;
        _mandates[id] = m;
        for (uint256 i; i < payees.length; ++i) {
            if (payees[i] == address(0)) revert InvalidParams();
            isPayeeAllowed[id][payees[i]] = true;
        }
        emit MandateCreated(
            id, m.parentId, m.owner, m.agent, m.budget, m.perPaymentCap, m.expiresAt
        );
    }

    function _requireActive(uint256 id) internal view returns (Mandate storage m) {
        m = _mandates[id];
        if (m.owner == address(0)) revert UnknownMandate();
        if (!isActive(id)) revert MandateInactive();
    }

    function _useNonce(uint256 mandateId, uint256 nonce, uint256 validBefore) internal {
        if (block.timestamp >= validBefore) revert AuthExpired();
        if (nonceUsed[mandateId][nonce]) revert NonceUsed();
        nonceUsed[mandateId][nonce] = true;
    }

    function _remaining(Mandate storage m) internal view returns (uint256) {
        return uint256(m.budget) - m.spent - m.delegated;
    }
}
