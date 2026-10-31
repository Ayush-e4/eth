// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MandateSignatures} from "./MandateSignatures.sol";

/// @notice Mandate storage, views and the checks every payment shares (direct or escrowed).
abstract contract MandateStore is MandateSignatures {
    /// Root is depth 0; sub-mandates can nest this deep.
    uint8 public constant MAX_DEPTH = 3;

    uint256 public mandateCount;
    mapping(uint256 id => Mandate) internal _mandates;
    mapping(uint256 id => mapping(address payee => bool)) public isPayeeAllowed;
    mapping(uint256 id => mapping(uint256 nonce => bool)) public nonceUsed;

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

    /// @dev Every rule a payment must pass, then its spend is counted. The caller moves the money.
    function _authorize(
        uint256 mandateId,
        address payTo,
        uint256 amount,
        uint256 nonce,
        uint256 validBefore,
        bytes32 digest,
        bytes memory signature
    ) internal returns (Mandate storage m) {
        m = _requireActive(mandateId);
        _useNonce(mandateId, nonce, validBefore);
        _requireSignedBy(m.agent, digest, signature);

        if (amount == 0) revert InvalidParams();
        if (amount > m.perPaymentCap) revert OverPaymentCap();
        if (amount > _remaining(m)) revert OverBudget();
        if (m.restrictPayees && !isPayeeAllowed[mandateId][payTo]) revert PayeeNotAllowed();

        // amount <= perPaymentCap (uint128), so the cast is safe.
        // forge-lint: disable-next-line(unsafe-typecast)
        m.spent += uint128(amount);
        emit Paid(mandateId, payTo, amount, nonce);
    }

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
