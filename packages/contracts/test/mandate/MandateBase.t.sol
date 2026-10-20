// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MandateRegistry} from "../../src/MandateRegistry.sol";
import {IMandateRegistry} from "../../src/mandate/IMandateRegistry.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

/// @dev Shared setup: an owner with 1000 USDC who approved the registry, a trip agent,
///   a flights agent, and two merchants. Helpers build and sign authorisations.
abstract contract MandateBase is Test {
    MandateRegistry registry;
    MockUSDC usdc;

    address owner = makeAddr("owner");
    uint256 tripKey = 0xA11CE;
    uint256 flightsKey = 0xB0B;
    address tripAgent;
    address flightsAgent;
    address airline = makeAddr("airline");
    address hotel = makeAddr("hotel");
    address attacker = makeAddr("attacker");

    uint128 constant BUDGET = 40e6; // 40 USDC
    uint128 constant CAP = 15e6; // 15 USDC per payment

    function setUp() public virtual {
        registry = new MandateRegistry();
        usdc = new MockUSDC();
        tripAgent = vm.addr(tripKey);
        flightsAgent = vm.addr(flightsKey);
        usdc.mint(owner, 1000e6);
        vm.prank(owner);
        usdc.approve(address(registry), type(uint256).max);
    }

    function _payees(address a, address b) internal pure returns (address[] memory p) {
        p = new address[](2);
        p[0] = a;
        p[1] = b;
    }

    function _params(address[] memory payees)
        internal
        view
        returns (IMandateRegistry.MandateParams memory)
    {
        return IMandateRegistry.MandateParams({
            agent: tripAgent,
            token: address(usdc),
            budget: BUDGET,
            perPaymentCap: CAP,
            expiresAt: uint64(block.timestamp + 1 days),
            payees: payees
        });
    }

    /// Root mandate: trip agent, 40 USDC budget, 15 cap, airline + hotel only.
    function _createRoot() internal returns (uint256 id) {
        vm.prank(owner);
        id = registry.createMandate(_params(_payees(airline, hotel)));
    }

    function _auth(uint256 id, address payTo, uint256 amount, uint256 nonce)
        internal
        view
        returns (IMandateRegistry.PaymentAuth memory)
    {
        return IMandateRegistry.PaymentAuth(id, payTo, amount, nonce, block.timestamp + 5 minutes);
    }

    function _sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signPay(uint256 key, IMandateRegistry.PaymentAuth memory a)
        internal
        view
        returns (bytes memory)
    {
        return _sign(key, registry.paymentDigest(a));
    }

    /// Signs and submits a payment as `key`.
    function _pay(uint256 key, uint256 id, address payTo, uint256 amount, uint256 nonce) internal {
        IMandateRegistry.PaymentAuth memory a = _auth(id, payTo, amount, nonce);
        registry.pay(a, _signPay(key, a));
    }

    function _subAuth(uint256 parentId, uint128 budget, address[] memory payees, uint256 nonce)
        internal
        view
        returns (IMandateRegistry.SubMandateAuth memory)
    {
        return IMandateRegistry.SubMandateAuth({
            parentId: parentId,
            agent: flightsAgent,
            budget: budget,
            perPaymentCap: budget < CAP ? budget : CAP,
            expiresAt: uint64(block.timestamp + 12 hours),
            payeesHash: keccak256(abi.encodePacked(payees)),
            nonce: nonce,
            validBefore: block.timestamp + 5 minutes
        });
    }

    /// Trip agent delegates `budget` to the flights agent, airline only.
    function _createSub(uint256 parentId, uint128 budget) internal returns (uint256 id) {
        address[] memory payees = new address[](1);
        payees[0] = airline;
        IMandateRegistry.SubMandateAuth memory a = _subAuth(parentId, budget, payees, 1000);
        id = registry.createSubMandate(a, payees, _sign(tripKey, registry.subMandateDigest(a)));
    }
}
