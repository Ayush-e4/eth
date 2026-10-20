// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IMandateRegistry} from "../../src/mandate/IMandateRegistry.sol";
import {MandateBase} from "./MandateBase.t.sol";

contract PayTest is MandateBase {
    uint256 id;

    function setUp() public override {
        super.setUp();
        id = _createRoot();
    }

    function test_paysWithinRules() public {
        _pay(tripKey, id, airline, 12e6, 1);
        assertEq(usdc.balanceOf(airline), 12e6);
        assertEq(usdc.balanceOf(owner), 1000e6 - 12e6);
        assertEq(registry.remaining(id), BUDGET - 12e6);
        assertEq(registry.getMandate(id).spent, 12e6);
    }

    function test_fundsNeverSitInRegistry() public {
        _pay(tripKey, id, airline, 12e6, 1);
        assertEq(usdc.balanceOf(address(registry)), 0);
    }

    function test_emitsPaid() public {
        vm.expectEmit(true, true, false, true);
        emit IMandateRegistry.Paid(id, airline, 5e6, 1);
        _pay(tripKey, id, airline, 5e6, 1);
    }

    function test_revertsOverPaymentCap() public {
        IMandateRegistry.PaymentAuth memory a = _auth(id, airline, CAP + 1, 1);
        bytes memory sig = _signPay(tripKey, a);
        vm.expectRevert(IMandateRegistry.OverPaymentCap.selector);
        registry.pay(a, sig);
    }

    function test_revertsOverBudget() public {
        _pay(tripKey, id, airline, 15e6, 1);
        _pay(tripKey, id, hotel, 15e6, 2);
        IMandateRegistry.PaymentAuth memory a = _auth(id, airline, 10e6 + 1, 3); // 30 + 10.000001 > 40
        bytes memory sig = _signPay(tripKey, a);
        vm.expectRevert(IMandateRegistry.OverBudget.selector);
        registry.pay(a, sig);
    }

    function test_revertsPayeeNotAllowed() public {
        IMandateRegistry.PaymentAuth memory a = _auth(id, attacker, 1e6, 1);
        bytes memory sig = _signPay(tripKey, a);
        vm.expectRevert(IMandateRegistry.PayeeNotAllowed.selector);
        registry.pay(a, sig);
    }

    function test_revertsWrongSigner() public {
        IMandateRegistry.PaymentAuth memory a = _auth(id, airline, 1e6, 1);
        bytes memory sig = _signPay(flightsKey, a); // not this mandate's agent
        vm.expectRevert(IMandateRegistry.BadSignature.selector);
        registry.pay(a, sig);
    }

    function test_revertsTamperedAmount() public {
        IMandateRegistry.PaymentAuth memory a = _auth(id, airline, 1e6, 1);
        bytes memory sig = _signPay(tripKey, a);
        a.amount = 10e6; // agent signed 1 USDC; someone submits 10
        vm.expectRevert(IMandateRegistry.BadSignature.selector);
        registry.pay(a, sig);
    }

    function test_revertsReplayedNonce() public {
        IMandateRegistry.PaymentAuth memory a = _auth(id, airline, 1e6, 1);
        bytes memory sig = _signPay(tripKey, a);
        registry.pay(a, sig);
        vm.expectRevert(IMandateRegistry.NonceUsed.selector);
        registry.pay(a, sig);
    }

    function test_revertsExpiredAuthorisation() public {
        IMandateRegistry.PaymentAuth memory a = _auth(id, airline, 1e6, 1);
        bytes memory sig = _signPay(tripKey, a);
        vm.warp(a.validBefore);
        vm.expectRevert(IMandateRegistry.AuthExpired.selector);
        registry.pay(a, sig);
    }

    function test_revertsExpiredMandate() public {
        vm.warp(block.timestamp + 1 days);
        IMandateRegistry.PaymentAuth memory a = _auth(id, airline, 1e6, 1);
        bytes memory sig = _signPay(tripKey, a);
        vm.expectRevert(IMandateRegistry.MandateInactive.selector);
        registry.pay(a, sig);
    }

    function test_revertsZeroAmount() public {
        IMandateRegistry.PaymentAuth memory a = _auth(id, airline, 0, 1);
        bytes memory sig = _signPay(tripKey, a);
        vm.expectRevert(IMandateRegistry.InvalidParams.selector);
        registry.pay(a, sig);
    }

    function test_failedPaymentDoesNotConsumeNonce() public {
        IMandateRegistry.PaymentAuth memory a = _auth(id, attacker, 1e6, 7);
        bytes memory sig = _signPay(tripKey, a);
        vm.expectRevert(IMandateRegistry.PayeeNotAllowed.selector);
        registry.pay(a, sig);
        assertFalse(registry.nonceUsed(id, 7));
    }

    function test_revertsWhenOwnerAllowanceRemoved() public {
        vm.prank(owner);
        usdc.approve(address(registry), 0); // owner pulls the plug at the token level
        IMandateRegistry.PaymentAuth memory a = _auth(id, airline, 1e6, 1);
        bytes memory sig = _signPay(tripKey, a);
        vm.expectRevert();
        registry.pay(a, sig);
    }

    function test_anyRelayerCanSubmit() public {
        IMandateRegistry.PaymentAuth memory a = _auth(id, airline, 1e6, 1);
        bytes memory sig = _signPay(tripKey, a);
        vm.prank(makeAddr("relayer"));
        registry.pay(a, sig);
        assertEq(usdc.balanceOf(airline), 1e6);
    }
}
