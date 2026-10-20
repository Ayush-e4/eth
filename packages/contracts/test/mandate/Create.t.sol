// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IMandateRegistry} from "../../src/mandate/IMandateRegistry.sol";
import {MandateBase} from "./MandateBase.t.sol";

contract CreateTest is MandateBase {
    function test_createsRootMandate() public {
        uint256 id = _createRoot();
        IMandateRegistry.Mandate memory m = registry.getMandate(id);
        assertEq(id, 1);
        assertEq(m.owner, owner);
        assertEq(m.agent, tripAgent);
        assertEq(m.budget, BUDGET);
        assertEq(m.perPaymentCap, CAP);
        assertEq(m.depth, 0);
        assertTrue(m.restrictPayees);
        assertTrue(registry.isPayeeAllowed(id, airline));
        assertFalse(registry.isPayeeAllowed(id, attacker));
        assertTrue(registry.isActive(id));
    }

    function test_emptyPayeesMeansAnyPayee() public {
        vm.prank(owner);
        uint256 id = registry.createMandate(_params(new address[](0)));
        assertFalse(registry.getMandate(id).restrictPayees);
        _pay(tripKey, id, attacker, 1e6, 1);
        assertEq(usdc.balanceOf(attacker), 1e6);
    }

    function test_revertsCapAboveBudget() public {
        IMandateRegistry.MandateParams memory p = _params(_payees(airline, hotel));
        p.perPaymentCap = p.budget + 1;
        vm.expectRevert(IMandateRegistry.InvalidParams.selector);
        registry.createMandate(p);
    }

    function test_revertsPastExpiry() public {
        IMandateRegistry.MandateParams memory p = _params(_payees(airline, hotel));
        p.expiresAt = uint64(block.timestamp);
        vm.expectRevert(IMandateRegistry.InvalidParams.selector);
        registry.createMandate(p);
    }

    function test_revertsZeroAgentOrBudget() public {
        IMandateRegistry.MandateParams memory p = _params(_payees(airline, hotel));
        p.agent = address(0);
        vm.expectRevert(IMandateRegistry.InvalidParams.selector);
        registry.createMandate(p);

        p = _params(_payees(airline, hotel));
        p.budget = 0;
        vm.expectRevert(IMandateRegistry.InvalidParams.selector);
        registry.createMandate(p);
    }

    function test_revertsZeroPayee() public {
        vm.expectRevert(IMandateRegistry.InvalidParams.selector);
        registry.createMandate(_params(_payees(airline, address(0))));
    }

    function test_unknownMandateIsInactive() public view {
        assertFalse(registry.isActive(42));
    }
}
