// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {PasskeySignature} from "../../src/wallet/PasskeySignature.sol";
import {PasskeyWalletV2} from "../../src/wallet/PasskeyWalletV2.sol";
import {PasskeyWalletFactoryV2} from "../../src/wallet/PasskeyWalletFactoryV2.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

/// @dev Two devices, one wallet: the phone's passkey made it; the laptop's is let in by the
///   phone (a batch calling addKey), and can be shut out again the same way.
contract PasskeyWalletV2Test is Test {
    uint256 constant N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;
    uint256 constant PHONE = 0x5eed;
    uint256 constant LAPTOP = 0xbeef;

    PasskeyWalletFactoryV2 factory;
    PasskeyWalletV2 wallet;
    MockUSDC usdc;
    address payee = makeAddr("payee");

    function setUp() public {
        factory = new PasskeyWalletFactoryV2();
        usdc = new MockUSDC();
        (bytes32 x, bytes32 y) = _pub(PHONE);
        wallet = PasskeyWalletV2(payable(factory.create(x, y, address(0))));
        usdc.mint(address(wallet), 5e6);
    }

    function _pub(uint256 key) internal pure returns (bytes32, bytes32) {
        (uint256 x, uint256 y) = vm.publicKeyP256(key);
        return (bytes32(x), bytes32(y));
    }

    /// What a device returns for challenge `d`, with which key signed it.
    function _sign(uint256 key, bytes32 d) internal pure returns (PasskeyWalletV2.KeySig memory k) {
        PasskeySignature.Assertion memory a;
        a.authenticatorData = abi.encodePacked(sha256("localhost"), bytes1(0x05), uint32(1));
        a.clientDataJSON = string.concat(
            '{"type":"webauthn.get","challenge":"',
            Base64.encodeURL(abi.encodePacked(d)),
            '","origin":"http://localhost:3000"}'
        );
        a.typeIndex = 1;
        a.challengeIndex = 23;
        bytes32 h = sha256(abi.encodePacked(a.authenticatorData, sha256(bytes(a.clientDataJSON))));
        (bytes32 r, bytes32 s) = vm.signP256(key, h);
        if (uint256(s) > N / 2) s = bytes32(N - uint256(s));
        (a.r, a.s) = (r, s);
        (k.qx, k.qy) = _pub(key);
        k.sig = a;
    }

    function _pay(uint256 amount) internal view returns (PasskeyWalletV2.Call[] memory c) {
        c = new PasskeyWalletV2.Call[](1);
        c[0] =
            PasskeyWalletV2.Call(address(usdc), 0, abi.encodeCall(usdc.transfer, (payee, amount)));
    }

    function _selfCall(bytes memory data) internal view returns (PasskeyWalletV2.Call[] memory c) {
        c = new PasskeyWalletV2.Call[](1);
        c[0] = PasskeyWalletV2.Call(address(wallet), 0, data);
    }

    /// Signs `calls` with `key` and runs them (expecting `err` if not empty).
    function _run(uint256 key, PasskeyWalletV2.Call[] memory calls, bytes memory err) internal {
        uint256 deadline = block.timestamp + 300;
        PasskeyWalletV2.KeySig memory k = _sign(key, wallet.digest(calls, deadline));
        if (err.length > 0) vm.expectRevert(err);
        wallet.execute(calls, deadline, k);
    }

    function test_theFirstPasskeyRunsTheWallet() public {
        _run(PHONE, _pay(1e6), "");
        assertEq(usdc.balanceOf(payee), 1e6);
        assertEq(wallet.keyCount(), 1);
    }

    function test_anotherDeviceGetsInOnlyWhenATrustedPasskeyLetsItIn() public {
        bytes memory notAKey = abi.encodeWithSelector(PasskeyWalletV2.NotAKey.selector);
        _run(LAPTOP, _pay(1e6), notAKey); // a stranger

        (bytes32 x, bytes32 y) = _pub(LAPTOP);
        vm.expectRevert(PasskeyWalletV2.OnlySelf.selector);
        wallet.addKey(x, y); // nobody can add a key from outside

        _run(PHONE, _selfCall(abi.encodeCall(wallet.addKey, (x, y))), "");
        assertEq(wallet.keyCount(), 2);
        _run(LAPTOP, _pay(2e6), ""); // now the laptop can
        assertEq(usdc.balanceOf(payee), 2e6);
    }

    function test_aLostDeviceIsShutOut_butNeverTheLastKey() public {
        (bytes32 lx, bytes32 ly) = _pub(LAPTOP);
        (bytes32 px, bytes32 py) = _pub(PHONE);
        _run(PHONE, _selfCall(abi.encodeCall(wallet.addKey, (lx, ly))), "");
        _run(PHONE, _selfCall(abi.encodeCall(wallet.removeKey, (lx, ly))), "");
        _run(LAPTOP, _pay(1e6), abi.encodeWithSelector(PasskeyWalletV2.NotAKey.selector));

        bytes memory lastKey = abi.encodeWithSelector(
            PasskeyWalletV2.CallFailed.selector,
            0,
            abi.encodeWithSelector(PasskeyWalletV2.LastKey.selector)
        );
        _run(PHONE, _selfCall(abi.encodeCall(wallet.removeKey, (px, py))), lastKey);
        assertEq(wallet.keyCount(), 1);
    }

    function test_aSignatureOverSomethingElseFails() public {
        uint256 deadline = block.timestamp + 300;
        PasskeyWalletV2.KeySig memory k = _sign(PHONE, wallet.digest(_pay(1e6), deadline));
        vm.expectRevert(PasskeyWalletV2.BadSignature.selector);
        wallet.execute(_pay(5e6), deadline, k);
    }

    function test_erc1271_acceptsAnyOfItsKeys() public {
        bytes32 h = keccak256("anything");
        assertEq(wallet.isValidSignature(h, abi.encode(_sign(PHONE, h))), bytes4(0x1626ba7e));
        assertEq(wallet.isValidSignature(h, abi.encode(_sign(LAPTOP, h))), bytes4(0xffffffff));
    }

    function test_factoryMakesOneWalletPerFirstPasskey() public {
        (bytes32 x, bytes32 y) = _pub(PHONE);
        assertEq(factory.addressOf(x, y), address(wallet));
        assertEq(factory.create(x, y, address(0)), address(wallet));
    }
}
