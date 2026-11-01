// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PasskeySignature} from "./PasskeySignature.sol";

/// @title PasskeyWalletV2
/// @notice A wallet controlled by passkeys (Face ID, a fingerprint) on one or more devices. Anyone
///   may submit a batch of calls (our server does, and pays the gas), but the wallet runs it
///   only with a signature from one of its passkeys over exactly that batch, this wallet, this
///   chain, its current nonce and a deadline. Adding or removing a passkey is itself such a batch
///   (a call to the wallet), so only a passkey it already trusts can let another device in.
/// @dev Not upgradeable, no admin. v1 (PasskeyWallet) had a single key; wallets made with it stay
///   as they are.
contract PasskeyWalletV2 {
    struct Call {
        address to;
        uint256 value;
        bytes data;
    }

    /// @notice Which passkey signed, and its WebAuthn assertion.
    struct KeySig {
        bytes32 qx;
        bytes32 qy;
        PasskeySignature.Assertion sig;
    }

    address internal constant HTS = address(0x167);
    int64 internal constant HTS_SUCCESS = 22;
    int64 internal constant HTS_ALREADY_ASSOCIATED = 194;
    bytes4 internal constant ERC1271_OK = 0x1626ba7e;

    address public immutable factory;
    uint256 public nonce; // each signed batch runs once
    uint256 public keyCount;
    mapping(bytes32 id => bool) public isKey; // keccak256(qx, qy) of each passkey's public key

    event Executed(uint256 indexed nonce, bytes32 digest);
    event KeyAdded(bytes32 qx, bytes32 qy);
    event KeyRemoved(bytes32 qx, bytes32 qy);

    error Expired();
    error NotAKey();
    error BadSignature();
    error CallFailed(uint256 index, bytes reason);
    error OnlyFactory();
    error OnlySelf();
    error LastKey();
    error AssociationFailed(int64 code);

    constructor(bytes32 qx, bytes32 qy) {
        factory = msg.sender;
        _add(qx, qy);
    }

    receive() external payable {}

    function keyId(bytes32 qx, bytes32 qy) public pure returns (bytes32) {
        return keccak256(abi.encode(qx, qy));
    }

    /// @notice What a passkey signs to run `calls` (it's the WebAuthn challenge).
    function digest(Call[] calldata calls, uint256 deadline) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), nonce, deadline, calls));
    }

    /// @notice Runs `calls` in order, all or nothing, if one of the wallet's passkeys signed them.
    function execute(Call[] calldata calls, uint256 deadline, KeySig calldata k) external {
        if (block.timestamp > deadline) revert Expired();
        if (!isKey[keyId(k.qx, k.qy)]) revert NotAKey();
        bytes32 d = digest(calls, deadline);
        if (!PasskeySignature.verify(d, k.sig, k.qx, k.qy)) revert BadSignature();
        emit Executed(nonce++, d);
        for (uint256 i = 0; i < calls.length; i++) {
            // The batch is whatever the passkey signed, so calling out in a loop is the point.
            // slither-disable-next-line arbitrary-send-eth,low-level-calls,calls-loop
            (bool ok, bytes memory ret) = calls[i].to.call{value: calls[i].value}(calls[i].data);
            if (!ok) revert CallFailed(i, ret);
        }
    }

    /// @notice Trust another device's passkey. Only through `execute` (a passkey it trusts).
    function addKey(bytes32 qx, bytes32 qy) external {
        if (msg.sender != address(this)) revert OnlySelf();
        _add(qx, qy);
    }

    /// @notice Stop trusting a passkey (a lost device). Never the last one.
    function removeKey(bytes32 qx, bytes32 qy) external {
        if (msg.sender != address(this)) revert OnlySelf();
        bytes32 id = keyId(qx, qy);
        if (!isKey[id]) revert NotAKey();
        if (keyCount == 1) revert LastKey();
        delete isKey[id];
        keyCount--;
        emit KeyRemoved(qx, qy);
    }

    /// @notice ERC-1271: `signature` is an abi-encoded KeySig from one of the wallet's passkeys.
    function isValidSignature(bytes32 hash, bytes calldata signature)
        external
        view
        returns (bytes4)
    {
        KeySig memory k = abi.decode(signature, (KeySig));
        return isKey[keyId(k.qx, k.qy)] && PasskeySignature.verify(hash, k.sig, k.qx, k.qy)
            ? ERC1271_OK
            : bytes4(0xffffffff);
    }

    /// @notice Hedera: lets the wallet hold `token` (an account must opt in to each token).
    ///   The factory does this once at creation; later tokens go through `execute`.
    function associate(address token) external {
        if (msg.sender != factory) revert OnlyFactory();
        if (token == address(0)) revert AssociationFailed(-1);
        // slither-disable-next-line low-level-calls
        (bool ok, bytes memory res) = HTS.call(
            abi.encodeWithSignature("associateToken(address,address)", address(this), token)
        );
        int64 code = ok && res.length >= 32 ? abi.decode(res, (int64)) : int64(-1);
        if (code != HTS_SUCCESS && code != HTS_ALREADY_ASSOCIATED) revert AssociationFailed(code);
    }

    function _add(bytes32 qx, bytes32 qy) private {
        bytes32 id = keyId(qx, qy);
        if (isKey[id]) return;
        isKey[id] = true;
        keyCount++;
        emit KeyAdded(qx, qy);
    }
}
