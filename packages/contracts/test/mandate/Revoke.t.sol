// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IMandateRegistry} from "../../src/mandate/IMandateRegistry.sol";
import {MandateBase} from "./MandateBase.t.sol";

contract RevokeTest is MandateBase {
    uint256 root;
    uint256 sub;

    function setUp() public override {
        super.setUp();
        root = _createRoot();
        sub = _createSub(root, 15e6);
    }

    function _expectPayFails(uint256 key, uint256 id, uint256 nonce) internal {
        IMandateRegistry.PaymentAuth memory a = _auth(id, airline, 1e6, nonce);
        bytes memory sig = _signPay(key, a);
        vm.expectRevert(IMandateRegistry.MandateInactive.selector);
        registry.pay(a, sig);
    }

    function test_ownerRevokeStopsRootAndAllSubs() public {
        vm.prank(owner);
        registry.revoke(root);
        assertFalse(registry.isActive(root));
        assertFalse(registry.isActive(sub)); // cascade via ancestor check
        _expectPayFails(tripKey, root, 1);
        _expectPayFails(flightsKey, sub, 1);
    }

    function test_revokeBlocksAlreadySignedPayments() public {
        IMandateRegistry.PaymentAuth memory a = _auth(sub, airline, 1e6, 1);
        bytes memory sig = _signPay(flightsKey, a); // signed before the revoke
        vm.prank(owner);
        registry.revoke(root);
        vm.expectRevert(IMandateRegistry.MandateInactive.selector);
        registry.pay(a, sig);
    }

    function test_parentAgentCanRevokeChild() public {
        vm.prank(tripAgent);
        registry.revoke(sub);
        assertFalse(registry.isActive(sub));
        assertTrue(registry.isActive(root)); // parent unaffected
    }

    function test_agentCanRevokeOwnMandate() public {
        vm.prank(flightsAgent);
        registry.revoke(sub);
        assertFalse(registry.isActive(sub));
    }

    function test_childAgentCannotRevokeParent() public {
        vm.prank(flightsAgent);
        vm.expectRevert(IMandateRegistry.NotAuthorized.selector);
        registry.revoke(root);
    }

    function test_strangerCannotRevoke() public {
        vm.prank(attacker);
        vm.expectRevert(IMandateRegistry.NotAuthorized.selector);
        registry.revoke(root);
    }

    function test_emitsRevoked() public {
        vm.expectEmit(true, true, false, false);
        emit IMandateRegistry.Revoked(root, owner);
        vm.prank(owner);
        registry.revoke(root);
    }

    function test_revokedParentBlocksNewSubs() public {
        vm.prank(owner);
        registry.revoke(root);
        address[] memory payees = new address[](1);
        payees[0] = airline;
        IMandateRegistry.SubMandateAuth memory a = _subAuth(root, 5e6, payees, 5);
        bytes memory sig = _sign(tripKey, registry.subMandateDigest(a));
        vm.expectRevert(IMandateRegistry.MandateInactive.selector);
        registry.createSubMandate(a, payees, sig);
    }

    function test_revertsUnknownMandate() public {
        vm.expectRevert(IMandateRegistry.UnknownMandate.selector);
        registry.revoke(999);
    }
}
