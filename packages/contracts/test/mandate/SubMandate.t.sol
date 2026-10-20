// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IMandateRegistry} from "../../src/mandate/IMandateRegistry.sol";
import {MandateBase} from "./MandateBase.t.sol";

contract SubMandateTest is MandateBase {
    uint256 root;

    function setUp() public override {
        super.setUp();
        root = _createRoot();
    }

    function _airlineOnly() internal view returns (address[] memory p) {
        p = new address[](1);
        p[0] = airline;
    }

    function _trySub(IMandateRegistry.SubMandateAuth memory a, address[] memory payees, bytes4 err)
        internal
    {
        bytes memory sig = _sign(tripKey, registry.subMandateDigest(a));
        vm.expectRevert(err);
        registry.createSubMandate(a, payees, sig);
    }

    function test_carvesBudgetOutOfParent() public {
        uint256 sub = _createSub(root, 15e6);
        IMandateRegistry.Mandate memory s = registry.getMandate(sub);
        assertEq(s.parentId, root);
        assertEq(s.agent, flightsAgent);
        assertEq(s.owner, owner);
        assertEq(s.depth, 1);
        assertEq(registry.getMandate(root).delegated, 15e6);
        assertEq(registry.remaining(root), BUDGET - 15e6);
    }

    function test_subAgentPaysFromOwnerFunds() public {
        uint256 sub = _createSub(root, 15e6);
        _pay(flightsKey, sub, airline, 12e6, 1);
        assertEq(usdc.balanceOf(airline), 12e6);
        assertEq(usdc.balanceOf(owner), 1000e6 - 12e6);
        assertEq(registry.remaining(sub), 3e6);
        assertEq(registry.remaining(root), BUDGET - 15e6); // already carved out
    }

    function test_subPayeesMustBeSubsetOfParent() public {
        address[] memory payees = new address[](1);
        payees[0] = attacker;
        _trySub(_subAuth(root, 10e6, payees, 1), payees, IMandateRegistry.PayeeNotAllowed.selector);
    }

    function test_subMustRestrictPayeesIfParentDoes() public {
        address[] memory none = new address[](0);
        _trySub(_subAuth(root, 10e6, none, 1), none, IMandateRegistry.PayeeNotAllowed.selector);
    }

    function test_subPayeeCannotBeOutsideItsOwnList() public {
        uint256 sub = _createSub(root, 15e6); // airline only
        IMandateRegistry.PaymentAuth memory a = _auth(sub, hotel, 1e6, 1);
        bytes memory sig = _signPay(flightsKey, a);
        vm.expectRevert(IMandateRegistry.PayeeNotAllowed.selector);
        registry.pay(a, sig);
    }

    function test_subBudgetCannotExceedParentRemaining() public {
        _pay(tripKey, root, hotel, 15e6, 1);
        _pay(tripKey, root, hotel, 15e6, 2); // 10 left
        _trySub(
            _subAuth(root, 11e6, _airlineOnly(), 3),
            _airlineOnly(),
            IMandateRegistry.OverBudget.selector
        );
    }

    function test_subCannotOutliveParent() public {
        IMandateRegistry.SubMandateAuth memory a = _subAuth(root, 10e6, _airlineOnly(), 1);
        a.expiresAt = uint64(block.timestamp + 2 days);
        _trySub(a, _airlineOnly(), IMandateRegistry.InvalidParams.selector);
    }

    function test_subCapCannotExceedParentCap() public {
        IMandateRegistry.SubMandateAuth memory a = _subAuth(root, 20e6, _airlineOnly(), 1);
        a.perPaymentCap = CAP + 1;
        _trySub(a, _airlineOnly(), IMandateRegistry.InvalidParams.selector);
    }

    function test_onlyParentAgentCanCreateSub() public {
        IMandateRegistry.SubMandateAuth memory a = _subAuth(root, 10e6, _airlineOnly(), 1);
        bytes memory sig = _sign(flightsKey, registry.subMandateDigest(a));
        vm.expectRevert(IMandateRegistry.BadSignature.selector);
        registry.createSubMandate(a, _airlineOnly(), sig);
    }

    function test_payeesMustMatchSignedHash() public {
        IMandateRegistry.SubMandateAuth memory a = _subAuth(root, 10e6, _airlineOnly(), 1);
        bytes memory sig = _sign(tripKey, registry.subMandateDigest(a));
        vm.expectRevert(IMandateRegistry.InvalidParams.selector);
        registry.createSubMandate(a, _payees(airline, hotel), sig); // swapped list
    }

    function test_depthLimit() public {
        uint256 parent = root;
        uint256 parentKey = tripKey;
        for (uint256 d = 1; d <= registry.MAX_DEPTH(); d++) {
            uint256 childKey = 0xC000 + d;
            IMandateRegistry.SubMandateAuth memory a = _subAuth(parent, 1e6, _airlineOnly(), d);
            a.agent = vm.addr(childKey);
            parent = registry.createSubMandate(
                a, _airlineOnly(), _sign(parentKey, registry.subMandateDigest(a))
            );
            parentKey = childKey;
        }
        IMandateRegistry.SubMandateAuth memory tooDeep = _subAuth(parent, 1e6, _airlineOnly(), 99);
        bytes memory sig = _sign(parentKey, registry.subMandateDigest(tooDeep));
        vm.expectRevert(IMandateRegistry.TooDeep.selector);
        registry.createSubMandate(tooDeep, _airlineOnly(), sig);
    }
}
