// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MandateStore} from "./MandateStore.sol";

/// @notice Pay on delivery. A payment passes the same checks as a direct one, but the money
///   waits in the registry until the job is done:
///   - the payee marks it delivered (by `deliverBy`), with a hash of what it delivered;
///   - the buyer (the mandate's agent or owner) releases it, or after `reviewSeconds` the
///     payee can claim it; during that window the buyer can dispute, freezing it;
///   - the payee can refund at any time, and if nothing is delivered by `deliverBy` anyone
///     can send it back. A refund also gives the budget back to the mandate.
///   Web2 analogy: an escrow service, run by code nobody can change.
abstract contract MandateEscrow is MandateStore {
    using SafeERC20 for IERC20;

    /// Hedera's token service precompile, and its response codes we accept.
    address internal constant HTS = address(0x167);
    int64 internal constant HTS_SUCCESS = 22;
    int64 internal constant HTS_ALREADY_ASSOCIATED = 194;

    mapping(bytes32 id => Escrow) internal _escrows;

    /// @notice One escrow per payment: its id follows from the mandate and the payment's nonce.
    function escrowIdOf(uint256 mandateId, uint256 nonce) public pure returns (bytes32) {
        return keccak256(abi.encode(mandateId, nonce));
    }

    function getEscrow(bytes32 id) external view returns (Escrow memory) {
        return _escrows[id];
    }

    /// @notice x402 entry point for pay-on-delivery, like `executeTransfer`.
    /// @param authorization abi.encode(mandateId, nonce, validBefore, deliverBy, reviewSeconds,
    ///   signature), the signature being the agent's EIP-712 EscrowAuth.
    function executeEscrowTransfer(
        address from,
        address asset,
        address to,
        uint256 amount,
        bytes calldata authorization
    ) external returns (bytes32) {
        (
            uint256 mandateId,
            uint256 nonce,
            uint256 validBefore,
            uint64 deliverBy,
            uint32 reviewSeconds,
            bytes memory signature
        ) = abi.decode(authorization, (uint256, uint256, uint256, uint64, uint32, bytes));
        Mandate storage m = _mandates[mandateId];
        if (m.owner != from || m.token != asset) revert WrongOwnerOrAsset();
        return _escrow(
            EscrowAuth(mandateId, to, amount, nonce, validBefore, deliverBy, reviewSeconds),
            signature
        );
    }

    /// @notice The same, without x402: anyone may submit an agent-signed EscrowAuth.
    function payIntoEscrow(EscrowAuth calldata a, bytes calldata signature)
        external
        returns (bytes32)
    {
        return _escrow(a, signature);
    }

    /// @notice The payee says the job is done (only before `deliverBy`).
    function markDelivered(bytes32 id, bytes32 resultHash) external {
        Escrow storage e = _escrowOf(id);
        if (msg.sender != e.payee) revert NotAuthorized();
        if (e.state != EscrowState.Held) revert WrongEscrowState();
        if (block.timestamp > e.deliverBy) revert TooLate();
        e.state = EscrowState.Delivered;
        e.deliveredAt = uint64(block.timestamp);
        e.resultHash = resultHash;
        emit Delivered(id, resultHash);
    }

    /// @notice The buyer is happy: pay the payee now.
    function release(bytes32 id) external {
        Escrow storage e = _escrowOf(id);
        if (!_isBuyer(e.mandateId, msg.sender)) revert NotAuthorized();
        if (!_open(e)) revert WrongEscrowState();
        _payOut(e, e.payee, EscrowState.Released);
        emit EscrowReleased(id, msg.sender);
    }

    /// @notice Delivered and the review window passed without a dispute: anyone may pay it out.
    function claim(bytes32 id) external {
        Escrow storage e = _escrowOf(id);
        if (e.state != EscrowState.Delivered) revert WrongEscrowState();
        if (block.timestamp < uint256(e.deliveredAt) + e.reviewSeconds) revert TooEarly();
        _payOut(e, e.payee, EscrowState.Released);
        emit EscrowReleased(id, msg.sender);
    }

    /// @notice The buyer objects to what was delivered, within the review window.
    function dispute(bytes32 id) external {
        Escrow storage e = _escrowOf(id);
        if (!_isBuyer(e.mandateId, msg.sender)) revert NotAuthorized();
        if (e.state != EscrowState.Delivered) revert WrongEscrowState();
        if (block.timestamp >= uint256(e.deliveredAt) + e.reviewSeconds) revert TooLate();
        e.state = EscrowState.Disputed;
        emit EscrowDisputed(id);
    }

    /// @notice The payee gives the money back (couldn't deliver, or settles a dispute).
    function refund(bytes32 id) external {
        Escrow storage e = _escrowOf(id);
        if (msg.sender != e.payee) revert NotAuthorized();
        if (!_open(e)) revert WrongEscrowState();
        _refund(id, e);
    }

    /// @notice Never delivered by the deadline: anyone may send it back to the payer.
    function reclaim(bytes32 id) external {
        Escrow storage e = _escrowOf(id);
        if (e.state != EscrowState.Held) revert WrongEscrowState();
        if (block.timestamp <= e.deliverBy) revert TooEarly();
        _refund(id, e);
    }

    /// @notice Hedera: lets the registry hold `token` (an account must opt in to each token).
    function associate(address token) external {
        if (token == address(0)) revert InvalidParams();
        // slither-disable-next-line low-level-calls
        (bool ok, bytes memory res) = HTS.call(
            abi.encodeWithSignature("associateToken(address,address)", address(this), token)
        );
        int64 code = ok && res.length >= 32 ? abi.decode(res, (int64)) : int64(-1);
        if (code != HTS_SUCCESS && code != HTS_ALREADY_ASSOCIATED) revert AssociationFailed(code);
    }

    // ─── Internals ──────────────────────────────────────────────────────

    function _escrow(EscrowAuth memory a, bytes memory signature) internal returns (bytes32 id) {
        if (a.deliverBy <= block.timestamp || a.reviewSeconds > 30 days) revert InvalidParams();
        Mandate storage m = _authorize(
            a.mandateId, a.payTo, a.amount, a.nonce, a.validBefore, escrowDigest(a), signature
        );
        id = escrowIdOf(a.mandateId, a.nonce);
        _escrows[id] = Escrow({
            mandateId: a.mandateId,
            payee: a.payTo,
            deliverBy: a.deliverBy,
            reviewSeconds: a.reviewSeconds,
            // forge-lint: disable-next-line(unsafe-typecast)
            amount: uint128(a.amount), // <= perPaymentCap (uint128), checked in _authorize
            deliveredAt: 0,
            state: EscrowState.Held,
            resultHash: bytes32(0)
        });
        emit Escrowed(id, a.mandateId, a.payTo, a.amount, a.deliverBy);
        // forge-lint: disable-next-line(arbitrary-send-erc20)
        // slither-disable-next-line arbitrary-send-erc20
        IERC20(m.token).safeTransferFrom(m.owner, address(this), a.amount);
    }

    function _refund(bytes32 id, Escrow storage e) internal {
        Mandate storage m = _mandates[e.mandateId];
        m.spent -= e.amount; // the money is back, so is the budget
        _payOut(e, m.owner, EscrowState.Refunded);
        emit EscrowRefunded(id, msg.sender);
    }

    function _payOut(Escrow storage e, address to, EscrowState state) internal {
        e.state = state;
        IERC20(_mandates[e.mandateId].token).safeTransfer(to, e.amount);
    }

    function _escrowOf(bytes32 id) internal view returns (Escrow storage e) {
        e = _escrows[id];
        if (e.state == EscrowState.None) revert UnknownEscrow();
    }

    function _open(Escrow storage e) internal view returns (bool) {
        return e.state == EscrowState.Held || e.state == EscrowState.Delivered
            || e.state == EscrowState.Disputed;
    }

    function _isBuyer(uint256 mandateId, address who) internal view returns (bool) {
        Mandate storage m = _mandates[mandateId];
        return who == m.agent || who == m.owner;
    }
}
