// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/Test.sol";
import {HederaProbe} from "../src/HederaProbe.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract HederaProbeTest is Test {
    HederaProbe probe;
    MockUSDC usdc;
    uint256 agentKey = 0xA11CE;
    address agent;
    address user = makeAddr("user");
    address merchant = makeAddr("merchant");

    function setUp() public {
        probe = new HederaProbe();
        usdc = new MockUSDC();
        agent = vm.addr(agentKey);
        usdc.mint(user, 10e6);
    }

    function _auth(uint256 amount) internal view returns (HederaProbe.PaymentAuth memory) {
        return HederaProbe.PaymentAuth(merchant, amount, 1, block.timestamp + 60);
    }

    function test_recoversAgentSignature() public view {
        HederaProbe.PaymentAuth memory a = _auth(1e6);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentKey, probe.digest(a));
        assertEq(probe.recoverSigner(a, abi.encodePacked(r, s, v)), agent);
    }

    function test_tamperedAuthRecoversDifferentSigner() public view {
        HederaProbe.PaymentAuth memory a = _auth(1e6);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentKey, probe.digest(a));
        a.amount = 1000e6; // agent signed 1 USDC, attacker asks for 1000
        assertTrue(probe.recoverSigner(a, abi.encodePacked(r, s, v)) != agent);
    }

    function test_pullsApprovedTokens() public {
        vm.prank(user);
        usdc.approve(address(probe), 2e6);
        probe.pull(IERC20(address(usdc)), user, merchant, 2e6);
        assertEq(usdc.balanceOf(merchant), 2e6);
        assertEq(usdc.balanceOf(user), 8e6);
    }

    function test_cannotPullMoreThanApproved() public {
        vm.prank(user);
        usdc.approve(address(probe), 1e6);
        vm.expectRevert();
        probe.pull(IERC20(address(usdc)), user, merchant, 2e6);
    }

    function test_onlyOwnerCanPull() public {
        vm.prank(user);
        usdc.approve(address(probe), 1e6);
        vm.prank(merchant);
        vm.expectRevert(HederaProbe.NotOwner.selector);
        probe.pull(IERC20(address(usdc)), user, merchant, 1e6);
    }
}
