// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IMandateRegistry} from "../../src/mandate/IMandateRegistry.sol";
import {MandateBase} from "./MandateBase.t.sol";

/// @dev Pay on delivery: the money waits in the registry until the job is delivered.
contract EscrowTest is MandateBase {
    uint256 id;
    uint32 constant REVIEW = 10 minutes;

    function setUp() public override {
        super.setUp();
        id = _createRoot();
    }

    function _escrowAuth(address payTo, uint256 amount, uint256 nonce)
        internal
        view
        returns (IMandateRegistry.EscrowAuth memory)
    {
        return IMandateRegistry.EscrowAuth(
            id,
            payTo,
            amount,
            nonce,
            block.timestamp + 5 minutes,
            uint64(block.timestamp + 1 hours),
            REVIEW
        );
    }

    /// The trip agent pays `amount` to the airline into escrow; returns the escrow id.
    function _hold(uint256 amount, uint256 nonce) internal returns (bytes32 eid) {
        IMandateRegistry.EscrowAuth memory a = _escrowAuth(airline, amount, nonce);
        eid = registry.payIntoEscrow(a, _sign(tripKey, registry.escrowDigest(a)));
    }

    function test_holdsTheMoneyNotThePayee() public {
        bytes32 eid = _hold(2e6, 1);
        assertEq(eid, registry.escrowIdOf(id, 1));
        assertEq(usdc.balanceOf(address(registry)), 2e6);
        assertEq(usdc.balanceOf(airline), 0);
        assertEq(registry.getMandate(id).spent, 2e6); // counts against the budget at once
        assertEq(uint8(registry.getEscrow(eid).state), uint8(IMandateRegistry.EscrowState.Held));
    }

    function test_deliveredThenReleasedByTheBuyer() public {
        bytes32 eid = _hold(2e6, 1);
        vm.prank(airline);
        registry.markDelivered(eid, keccak256("ticket"));
        vm.prank(tripAgent);
        registry.release(eid);
        assertEq(usdc.balanceOf(airline), 2e6);
        assertEq(usdc.balanceOf(address(registry)), 0);
        assertEq(uint8(registry.getEscrow(eid).state), uint8(IMandateRegistry.EscrowState.Released));
    }

    function test_payeeClaimsAfterTheReviewWindow() public {
        bytes32 eid = _hold(2e6, 1);
        vm.prank(airline);
        registry.markDelivered(eid, keccak256("ticket"));
        vm.expectRevert(IMandateRegistry.TooEarly.selector);
        registry.claim(eid);
        vm.warp(block.timestamp + REVIEW);
        registry.claim(eid);
        assertEq(usdc.balanceOf(airline), 2e6);
    }

    function test_refundGivesTheMoneyAndTheBudgetBack() public {
        uint256 before = usdc.balanceOf(owner);
        bytes32 eid = _hold(2e6, 1);
        vm.prank(airline);
        registry.refund(eid);
        assertEq(usdc.balanceOf(owner), before);
        assertEq(registry.getMandate(id).spent, 0);
        assertEq(uint8(registry.getEscrow(eid).state), uint8(IMandateRegistry.EscrowState.Refunded));
    }

    function test_neverDeliveredComesBackAfterTheDeadline() public {
        bytes32 eid = _hold(2e6, 1);
        vm.expectRevert(IMandateRegistry.TooEarly.selector);
        registry.reclaim(eid);
        vm.warp(block.timestamp + 1 hours + 1);
        vm.prank(attacker); // anyone can send it back, only to the payer
        registry.reclaim(eid);
        assertEq(usdc.balanceOf(owner), 1000e6);
        vm.prank(airline);
        vm.expectRevert(IMandateRegistry.WrongEscrowState.selector);
        registry.markDelivered(eid, keccak256("late"));
    }

    function test_disputeFreezesUntilSettled() public {
        bytes32 eid = _hold(2e6, 1);
        vm.prank(airline);
        registry.markDelivered(eid, keccak256("wrong ticket"));
        vm.prank(tripAgent);
        registry.dispute(eid);
        vm.warp(block.timestamp + REVIEW + 1);
        vm.expectRevert(IMandateRegistry.WrongEscrowState.selector);
        registry.claim(eid); // no payout by waiting it out
        vm.prank(airline);
        registry.refund(eid); // the payee settles it
        assertEq(usdc.balanceOf(owner), 1000e6);
    }

    function test_onlyTheRightPartiesCanAct() public {
        bytes32 eid = _hold(2e6, 1);
        vm.prank(attacker);
        vm.expectRevert(IMandateRegistry.NotAuthorized.selector);
        registry.markDelivered(eid, bytes32(0));
        vm.prank(attacker);
        vm.expectRevert(IMandateRegistry.NotAuthorized.selector);
        registry.release(eid);
        vm.prank(attacker);
        vm.expectRevert(IMandateRegistry.NotAuthorized.selector);
        registry.refund(eid);
        vm.prank(airline);
        vm.expectRevert(IMandateRegistry.NotAuthorized.selector);
        registry.release(eid); // the payee can't pay itself early
        vm.prank(owner); // the owner counts as the buyer too
        registry.release(eid);
        vm.prank(airline);
        vm.expectRevert(IMandateRegistry.WrongEscrowState.selector);
        registry.refund(eid); // nothing left once paid out
    }

    function test_deliveryAfterTheDeadlineIsRefused() public {
        bytes32 eid = _hold(2e6, 1);
        vm.warp(block.timestamp + 1 hours + 1);
        vm.prank(airline);
        vm.expectRevert(IMandateRegistry.TooLate.selector);
        registry.markDelivered(eid, keccak256("late"));
    }

    function test_sameRulesAsADirectPayment() public {
        IMandateRegistry.EscrowAuth memory a = _escrowAuth(attacker, 2e6, 1);
        bytes memory sig = _sign(tripKey, registry.escrowDigest(a));
        vm.expectRevert(IMandateRegistry.PayeeNotAllowed.selector);
        registry.payIntoEscrow(a, sig);
        _hold(2e6, 2);
        IMandateRegistry.EscrowAuth memory again = _escrowAuth(airline, 2e6, 2);
        bytes memory sig2 = _sign(tripKey, registry.escrowDigest(again));
        vm.expectRevert(IMandateRegistry.NonceUsed.selector);
        registry.payIntoEscrow(again, sig2);
        IMandateRegistry.EscrowAuth memory big = _escrowAuth(airline, CAP + 1, 3);
        bytes memory sig3 = _sign(tripKey, registry.escrowDigest(big));
        vm.expectRevert(IMandateRegistry.OverPaymentCap.selector);
        registry.payIntoEscrow(big, sig3);
    }

    function test_x402EntryBindsTheTermsToTheSignature() public {
        IMandateRegistry.EscrowAuth memory a = _escrowAuth(airline, 2e6, 7);
        bytes memory sig = _sign(tripKey, registry.escrowDigest(a));
        // a facilitator can't stretch the deadline the buyer signed
        bytes memory stretched =
            abi.encode(id, a.nonce, a.validBefore, a.deliverBy + 1 days, a.reviewSeconds, sig);
        vm.expectRevert(IMandateRegistry.BadSignature.selector);
        registry.executeEscrowTransfer(owner, address(usdc), airline, 2e6, stretched);
        bytes memory auth =
            abi.encode(id, a.nonce, a.validBefore, a.deliverBy, a.reviewSeconds, sig);
        vm.expectRevert(IMandateRegistry.WrongOwnerOrAsset.selector);
        registry.executeEscrowTransfer(attacker, address(usdc), airline, 2e6, auth);
        bytes32 eid = registry.executeEscrowTransfer(owner, address(usdc), airline, 2e6, auth);
        assertEq(eid, registry.escrowIdOf(id, 7));
        assertEq(usdc.balanceOf(address(registry)), 2e6);
    }

    function test_associateUsesHederasTokenService() public {
        vm.expectRevert(
            abi.encodeWithSelector(IMandateRegistry.AssociationFailed.selector, int64(-1))
        );
        registry.associate(address(usdc)); // no Hedera precompile here
        vm.mockCall(address(0x167), bytes(""), abi.encode(int64(22)));
        registry.associate(address(usdc));
    }
}
