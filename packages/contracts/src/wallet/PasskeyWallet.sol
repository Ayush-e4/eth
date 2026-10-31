// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PasskeySignature} from "./PasskeySignature.sol";

/// @title PasskeyWallet
/// @notice A wallet whose only key is a passkey: the person's Face ID or fingerprint. Anyone may
///   submit a batch of calls (our server does, and pays the gas), but the wallet runs it only
///   with a passkey signature over exactly that batch, this wallet, this chain, its current
///   nonce and a deadline. Nobody else, us included, can move what it holds.
/// @dev Not upgradeable, no admin, no recovery: lose every device with the passkey and the
///   wallet is stuck (fine for testnet money; a real one would add a second passkey).
contract PasskeyWallet {
    struct Call {
        address to;
        uint256 value;
        bytes data;
    }

    address internal constant HTS = address(0x167);
    int64 internal constant HTS_SUCCESS = 22;
    int64 internal constant HTS_ALREADY_ASSOCIATED = 194;
    bytes4 internal constant ERC1271_OK = 0x1626ba7e;

    bytes32 public immutable qx; // the passkey's P-256 public key
    bytes32 public immutable qy;
    address public immutable factory;
    uint256 public nonce; // each signed batch runs once

    event Executed(uint256 indexed nonce, bytes32 digest);

    error Expired();
    error BadSignature();
    error CallFailed(uint256 index, bytes reason);
    error OnlyFactory();
    error AssociationFailed(int64 code);

    constructor(bytes32 qx_, bytes32 qy_) {
        qx = qx_;
        qy = qy_;
        factory = msg.sender;
    }

    receive() external payable {}

    /// @notice What the passkey signs to run `calls` (it's the WebAuthn challenge).
    function digest(Call[] calldata calls, uint256 deadline) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), nonce, deadline, calls));
    }

    /// @notice Runs `calls` in order, all or nothing, if the passkey signed them.
    function execute(
        Call[] calldata calls,
        uint256 deadline,
        PasskeySignature.Assertion calldata sig
    ) external {
        if (block.timestamp > deadline) revert Expired();
        bytes32 d = digest(calls, deadline);
        if (!PasskeySignature.verify(d, sig, qx, qy)) revert BadSignature();
        emit Executed(nonce++, d);
        for (uint256 i = 0; i < calls.length; i++) {
            // The batch is whatever the passkey signed, so calling out in a loop is the point.
            // slither-disable-next-line arbitrary-send-eth,low-level-calls,calls-loop
            (bool ok, bytes memory ret) = calls[i].to.call{value: calls[i].value}(calls[i].data);
            if (!ok) revert CallFailed(i, ret);
        }
    }

    /// @notice ERC-1271: lets contracts accept the passkey's signature as this wallet's.
    function isValidSignature(bytes32 hash, bytes calldata signature)
        external
        view
        returns (bytes4)
    {
        PasskeySignature.Assertion memory a = abi.decode(signature, (PasskeySignature.Assertion));
        return PasskeySignature.verify(hash, a, qx, qy) ? ERC1271_OK : bytes4(0xffffffff);
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
}
