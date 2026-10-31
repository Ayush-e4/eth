// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MandateRegistry} from "../../src/MandateRegistry.sol";
import {IMandateRegistry} from "../../src/mandate/IMandateRegistry.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {MandateBase} from "./MandateBase.t.sol";

/// @dev Drives random sequences of payments, escrows, sub-mandates and revokes.
contract MandateHandler is Test {
    MandateRegistry public registry;
    MockUSDC public usdc;
    uint256[] public keys; // agent key per mandate index (id - 1)
    address[] public payees;
    uint256 public nonce = 1;
    uint256 public totalPaid; // reached a payee
    uint256 public held; // sitting in open escrows
    bytes32[] public escrows;

    constructor(MandateRegistry r, MockUSDC u, uint256 rootKey, address[] memory p) {
        registry = r;
        usdc = u;
        keys.push(rootKey);
        payees = p;
    }

    function _sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function pay(uint256 idSeed, uint256 payeeSeed, uint256 amount) external {
        uint256 id = bound(idSeed, 1, keys.length);
        address to = payees[bound(payeeSeed, 0, payees.length - 1)];
        amount = bound(amount, 1, 20e6);
        IMandateRegistry.PaymentAuth memory a =
            IMandateRegistry.PaymentAuth(id, to, amount, nonce++, block.timestamp + 60);
        try registry.pay(a, _sign(keys[id - 1], registry.paymentDigest(a))) {
            totalPaid += amount;
        } catch {}
    }

    /// Pay on delivery: into escrow, then delivered, released or refunded in any order.
    function hold(uint256 idSeed, uint256 payeeSeed, uint256 amount) external {
        uint256 id = bound(idSeed, 1, keys.length);
        address to = payees[bound(payeeSeed, 0, payees.length - 1)];
        amount = bound(amount, 1, 20e6);
        IMandateRegistry.EscrowAuth memory a = IMandateRegistry.EscrowAuth(
            id, to, amount, nonce++, block.timestamp + 60, uint64(block.timestamp + 1 hours), 60
        );
        try registry.payIntoEscrow(a, _sign(keys[id - 1], registry.escrowDigest(a))) returns (
            bytes32 eid
        ) {
            escrows.push(eid);
            held += amount;
        } catch {}
    }

    function _pick(uint256 seed) internal view returns (bytes32, IMandateRegistry.Escrow memory) {
        bytes32 eid = escrows[bound(seed, 0, escrows.length - 1)];
        return (eid, registry.getEscrow(eid));
    }

    function deliver(uint256 seed) external {
        if (escrows.length == 0) return;
        (bytes32 eid, IMandateRegistry.Escrow memory e) = _pick(seed);
        vm.prank(e.payee);
        try registry.markDelivered(eid, keccak256("done")) {} catch {}
    }

    function release(uint256 seed) external {
        if (escrows.length == 0) return;
        (bytes32 eid, IMandateRegistry.Escrow memory e) = _pick(seed);
        vm.prank(vm.addr(keys[e.mandateId - 1]));
        try registry.release(eid) {
            held -= e.amount;
            totalPaid += e.amount;
        } catch {}
    }

    function refund(uint256 seed) external {
        if (escrows.length == 0) return;
        (bytes32 eid, IMandateRegistry.Escrow memory e) = _pick(seed);
        vm.prank(e.payee);
        try registry.refund(eid) {
            held -= e.amount;
        } catch {}
    }

    function delegate(uint256 parentSeed, uint128 budget) external {
        uint256 parentId = bound(parentSeed, 1, keys.length);
        budget = uint128(bound(budget, 1, 20e6));
        uint256 childKey = 0xD000 + keys.length;
        address[] memory p = new address[](1);
        p[0] = payees[0];
        IMandateRegistry.Mandate memory parent = registry.getMandate(parentId);
        uint128 cap = budget < parent.perPaymentCap ? budget : parent.perPaymentCap;
        IMandateRegistry.SubMandateAuth memory a = IMandateRegistry.SubMandateAuth(
            parentId,
            vm.addr(childKey),
            budget,
            cap,
            parent.expiresAt,
            keccak256(abi.encodePacked(p)),
            nonce++,
            block.timestamp + 60
        );
        try registry.createSubMandate(
            a, p, _sign(keys[parentId - 1], registry.subMandateDigest(a))
        ) {
            keys.push(childKey);
        } catch {}
    }

    function revoke(uint256 idSeed) external {
        uint256 id = bound(idSeed, 1, keys.length);
        vm.prank(vm.addr(keys[id - 1]));
        registry.revoke(id);
    }

    function count() external view returns (uint256) {
        return keys.length;
    }
}

contract MandateInvariantTest is MandateBase {
    MandateHandler handler;

    function setUp() public override {
        super.setUp();
        _createRoot();
        handler = new MandateHandler(registry, usdc, tripKey, _payees(airline, hotel));
        targetContract(address(handler));
    }

    /// A mandate can never spend + delegate more than its budget.
    function invariant_neverExceedsBudget() public view {
        for (uint256 id = 1; id <= handler.count(); id++) {
            IMandateRegistry.Mandate memory m = registry.getMandate(id);
            assertLe(uint256(m.spent) + m.delegated, m.budget);
        }
    }

    /// The owner loses exactly what was paid or is still held, never more than the root budget.
    function invariant_ownerLosesExactlyWhatWasPaid() public view {
        assertEq(1000e6 - usdc.balanceOf(owner), handler.totalPaid() + handler.held());
        assertLe(handler.totalPaid() + handler.held(), BUDGET);
    }

    /// The registry holds exactly what's in open escrows, nothing more (and nothing gets stuck).
    function invariant_registryHoldsOnlyOpenEscrows() public view {
        assertEq(usdc.balanceOf(address(registry)), handler.held());
    }

    /// Only allowed payees ever receive funds.
    function invariant_onlyAllowedPayeesPaid() public view {
        assertEq(usdc.balanceOf(airline) + usdc.balanceOf(hotel), handler.totalPaid());
        assertEq(usdc.balanceOf(attacker), 0);
    }

    /// Sanity: the handler really pays and delegates, so the invariants aren't vacuous.
    function test_handlerMakesProgress() public {
        handler.pay(1, 0, 5e6);
        assertEq(handler.totalPaid(), 5e6);
        handler.delegate(1, 10e6);
        assertEq(handler.count(), 2);
        handler.pay(2, 0, 3e6);
        assertEq(handler.totalPaid(), 8e6);
        handler.hold(1, 1, 2e6);
        assertEq(handler.held(), 2e6);
        handler.deliver(0);
        handler.release(0);
        assertEq(handler.held(), 0);
        assertEq(handler.totalPaid(), 10e6);
    }

    /// Fuzz: any single payment above the cap is rejected.
    function testFuzz_rejectsAboveCap(uint256 amount) public {
        amount = bound(amount, uint256(CAP) + 1, type(uint128).max);
        IMandateRegistry.PaymentAuth memory a = _auth(1, airline, amount, 1);
        bytes memory sig = _signPay(tripKey, a);
        vm.expectRevert(IMandateRegistry.OverPaymentCap.selector);
        registry.pay(a, sig);
    }
}
