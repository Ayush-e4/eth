// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IMandateRegistry} from "../../src/mandate/IMandateRegistry.sol";
import {MandateBase} from "./MandateBase.t.sol";

/// @dev The x402 Hedera `transferExecutor` path: a facilitator calls executeTransfer.
contract X402Test is MandateBase {
    uint256 id;
    address facilitator = makeAddr("facilitator");

    function setUp() public override {
        super.setUp();
        id = _createRoot();
    }

    function _authorization(address to, uint256 amount, uint256 nonce)
        internal
        view
        returns (bytes memory)
    {
        IMandateRegistry.PaymentAuth memory a = _auth(id, to, amount, nonce);
        return abi.encode(id, nonce, a.validBefore, _signPay(tripKey, a));
    }

    function test_selectorMatchesSpec() public view {
        assertEq(registry.executeTransfer.selector, bytes4(0xea8f19fd));
    }

    function test_facilitatorSettlesPayment() public {
        bytes memory auth = _authorization(airline, 2e6, 1);
        vm.prank(facilitator);
        registry.executeTransfer(owner, address(usdc), airline, 2e6, auth);
        assertEq(usdc.balanceOf(airline), 2e6);
        assertEq(registry.getMandate(id).spent, 2e6);
    }

    function test_authorizationIsSingleUse() public {
        bytes memory auth = _authorization(airline, 2e6, 1);
        vm.startPrank(facilitator);
        registry.executeTransfer(owner, address(usdc), airline, 2e6, auth);
        vm.expectRevert(IMandateRegistry.NonceUsed.selector);
        registry.executeTransfer(owner, address(usdc), airline, 2e6, auth);
        vm.stopPrank();
    }

    function test_boundToRecipient() public {
        bytes memory auth = _authorization(airline, 2e6, 1);
        vm.expectRevert(IMandateRegistry.BadSignature.selector);
        registry.executeTransfer(owner, address(usdc), hotel, 2e6, auth);
    }

    function test_boundToAmount() public {
        bytes memory auth = _authorization(airline, 2e6, 1);
        vm.expectRevert(IMandateRegistry.BadSignature.selector);
        registry.executeTransfer(owner, address(usdc), airline, 3e6, auth);
    }

    function test_boundToFrom() public {
        bytes memory auth = _authorization(airline, 2e6, 1);
        vm.expectRevert(IMandateRegistry.WrongOwnerOrAsset.selector);
        registry.executeTransfer(attacker, address(usdc), airline, 2e6, auth);
    }

    function test_boundToAsset() public {
        bytes memory auth = _authorization(airline, 2e6, 1);
        vm.expectRevert(IMandateRegistry.WrongOwnerOrAsset.selector);
        registry.executeTransfer(owner, makeAddr("otherToken"), airline, 2e6, auth);
    }

    function test_rulesStillApply() public {
        bytes memory auth = _authorization(airline, CAP + 1, 1);
        vm.expectRevert(IMandateRegistry.OverPaymentCap.selector);
        registry.executeTransfer(owner, address(usdc), airline, CAP + 1, auth);
    }

    function test_onlyDebitsFrom() public {
        uint256 hotelBefore = usdc.balanceOf(hotel);
        registry.executeTransfer(
            owner, address(usdc), airline, 2e6, _authorization(airline, 2e6, 1)
        );
        assertEq(usdc.balanceOf(owner), 1000e6 - 2e6);
        assertEq(usdc.balanceOf(hotel), hotelBefore);
        assertEq(usdc.balanceOf(address(registry)), 0);
    }
}
