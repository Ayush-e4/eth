// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {MandateRegistry} from "../../src/MandateRegistry.sol";
import {IMandateRegistry} from "../../src/mandate/IMandateRegistry.sol";
import {PasskeySignature} from "../../src/wallet/PasskeySignature.sol";
import {PasskeyWallet} from "../../src/wallet/PasskeyWallet.sol";
import {PasskeyWalletFactory} from "../../src/wallet/PasskeyWalletFactory.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

/// @dev A passkey wallet setting a spending limit, the way the app will: the passkey signs one
///   batch (approve USDC + create the mandate) and anyone submits it.
contract PasskeyWalletTest is Test {
    uint256 constant N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;
    uint256 constant PASSKEY = 0x5eed;

    PasskeyWalletFactory factory;
    PasskeyWallet wallet;
    MandateRegistry registry;
    MockUSDC usdc;
    bytes32 qx;
    bytes32 qy;
    address concierge = makeAddr("concierge");
    address agent = makeAddr("agent");
    address relayer = makeAddr("relayer");

    function setUp() public {
        factory = new PasskeyWalletFactory();
        registry = new MandateRegistry();
        usdc = new MockUSDC();
        (uint256 x, uint256 y) = vm.publicKeyP256(PASSKEY);
        (qx, qy) = (bytes32(x), bytes32(y));
        wallet = PasskeyWallet(payable(factory.create(qx, qy, address(0))));
        usdc.mint(address(wallet), 5e6);
    }

    // ─── helpers ────────────────────────────────────────────────────────

    function _limitCalls(uint128 budget) internal view returns (PasskeyWallet.Call[] memory c) {
        address[] memory payees = new address[](1);
        payees[0] = agent;
        c = new PasskeyWallet.Call[](2);
        c[0] = PasskeyWallet.Call(
            address(usdc), 0, abi.encodeCall(usdc.approve, (address(registry), budget))
        );
        c[1] = PasskeyWallet.Call(
            address(registry),
            0,
            abi.encodeCall(
                registry.createMandate,
                (IMandateRegistry.MandateParams(
                        concierge,
                        address(usdc),
                        budget,
                        budget,
                        uint64(block.timestamp + 1 days),
                        payees
                    ))
            )
        );
    }

    /// What a phone returns for challenge `d`: authenticator data, client JSON, P-256 signature.
    function _sign(uint256 key, bytes32 d, bytes1 flags, string memory kind)
        internal
        pure
        returns (PasskeySignature.Assertion memory a)
    {
        a.authenticatorData = abi.encodePacked(sha256("localhost"), flags, uint32(1));
        a.clientDataJSON = string.concat(
            '{"type":"',
            kind,
            '","challenge":"',
            Base64.encodeURL(abi.encodePacked(d)),
            '","origin":"http://localhost:3000","crossOrigin":false}'
        );
        a.typeIndex = 1;
        a.challengeIndex = 9 + bytes(kind).length + 2;
        bytes32 h = sha256(abi.encodePacked(a.authenticatorData, sha256(bytes(a.clientDataJSON))));
        (bytes32 r, bytes32 s) = vm.signP256(key, h);
        if (uint256(s) > N / 2) s = bytes32(N - uint256(s)); // low s, as the app sends it
        (a.r, a.s) = (r, s);
    }

    function _sign(bytes32 d) internal pure returns (PasskeySignature.Assertion memory) {
        return _sign(PASSKEY, d, 0x05, "webauthn.get");
    }

    // ─── factory ────────────────────────────────────────────────────────

    function test_oneWalletPerPasskeyAtAKnownAddress() public {
        assertEq(address(wallet), factory.addressOf(qx, qy));
        assertEq(factory.create(qx, qy, address(0)), address(wallet)); // same one again
        assertEq(wallet.qx(), qx);
        (uint256 x2, uint256 y2) = vm.publicKeyP256(0xbeef);
        assertTrue(factory.addressOf(bytes32(x2), bytes32(y2)) != address(wallet));
    }

    function test_optsInToUsdcOnHedera() public {
        (uint256 x2, uint256 y2) = vm.publicKeyP256(0xbeef);
        vm.mockCall(address(0x167), bytes(""), abi.encode(int64(22)));
        factory.create(bytes32(x2), bytes32(y2), address(usdc));
        vm.expectRevert(PasskeyWallet.OnlyFactory.selector);
        wallet.associate(address(usdc));
    }

    // ─── execute ────────────────────────────────────────────────────────

    function test_passkeySetsASpendingLimit_anyoneSubmits() public {
        PasskeyWallet.Call[] memory calls = _limitCalls(1e6);
        uint256 deadline = block.timestamp + 300;
        PasskeySignature.Assertion memory sig = _sign(wallet.digest(calls, deadline));
        vm.prank(relayer);
        uint256 gasBefore = gasleft();
        wallet.execute(calls, deadline, sig);
        emit log_named_uint("gas for a limit (verify + approve + create)", gasBefore - gasleft());

        IMandateRegistry.Mandate memory m = registry.getMandate(1);
        assertEq(m.owner, address(wallet));
        assertEq(m.agent, concierge);
        assertEq(usdc.allowance(address(wallet), address(registry)), 1e6);
        assertEq(wallet.nonce(), 1);
    }

    function test_refusesReplayTamperingAndOtherKeys() public {
        PasskeyWallet.Call[] memory calls = _limitCalls(1e6);
        uint256 deadline = block.timestamp + 300;
        bytes32 d = wallet.digest(calls, deadline);
        PasskeySignature.Assertion memory sig = _sign(d);

        PasskeyWallet.Call[] memory bigger = _limitCalls(5e6);
        vm.expectRevert(PasskeyWallet.BadSignature.selector);
        wallet.execute(bigger, deadline, sig); // not what was signed

        PasskeySignature.Assertion memory other = _sign(0xbeef, d, 0x05, "webauthn.get");
        vm.expectRevert(PasskeyWallet.BadSignature.selector);
        wallet.execute(calls, deadline, other); // someone else's passkey

        wallet.execute(calls, deadline, sig);
        vm.expectRevert(PasskeyWallet.BadSignature.selector);
        wallet.execute(calls, deadline, sig); // used up: the nonce moved on
    }

    function test_needsFaceIdNotJustATap_andAGetCeremony() public {
        PasskeyWallet.Call[] memory calls = _limitCalls(1e6);
        uint256 deadline = block.timestamp + 300;
        bytes32 d = wallet.digest(calls, deadline);
        PasskeySignature.Assertion memory tapOnly = _sign(PASSKEY, d, 0x01, "webauthn.get");
        PasskeySignature.Assertion memory create = _sign(PASSKEY, d, 0x05, "webauthn.create");
        vm.expectRevert(PasskeyWallet.BadSignature.selector);
        wallet.execute(calls, deadline, tapOnly); // present, but not verified
        vm.expectRevert(PasskeyWallet.BadSignature.selector);
        wallet.execute(calls, deadline, create);
    }

    function test_expiresAndFailsAsAWhole() public {
        PasskeyWallet.Call[] memory calls = _limitCalls(1e6);
        uint256 deadline = block.timestamp + 300;
        PasskeySignature.Assertion memory sig = _sign(wallet.digest(calls, deadline));
        vm.warp(deadline + 1);
        vm.expectRevert(PasskeyWallet.Expired.selector);
        wallet.execute(calls, deadline, sig);

        vm.warp(1000);
        PasskeyWallet.Call[] memory bad = _limitCalls(0); // the registry refuses a zero budget
        uint256 dl = block.timestamp + 300;
        sig = _sign(wallet.digest(bad, dl));
        vm.expectRevert(
            abi.encodeWithSelector(
                PasskeyWallet.CallFailed.selector,
                1,
                abi.encodeWithSelector(IMandateRegistry.InvalidParams.selector)
            )
        );
        wallet.execute(bad, dl, sig);
        assertEq(usdc.allowance(address(wallet), address(registry)), 0); // approve rolled back
        assertEq(wallet.nonce(), 0);
    }

    function test_erc1271() public view {
        bytes32 h = keccak256("anything");
        assertEq(wallet.isValidSignature(h, abi.encode(_sign(h))), bytes4(0x1626ba7e));
        assertEq(
            wallet.isValidSignature(keccak256("else"), abi.encode(_sign(h))), bytes4(0xffffffff)
        );
    }
}
