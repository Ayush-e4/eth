// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PasskeyWalletV2} from "./PasskeyWalletV2.sol";

/// @title PasskeyWalletFactoryV2
/// @notice Makes one PasskeyWalletV2 per first passkey, at an address known before it exists (CREATE2
///   from the public key), and opts it in to a token (USDC) so it can receive it on Hedera.
///   Anyone may call it; the wallet answers only to its passkey either way.
contract PasskeyWalletFactoryV2 {
    event WalletCreated(address indexed wallet, bytes32 qx, bytes32 qy);

    /// @notice The wallet for this passkey, created (and opted in to `token`) if it isn't yet.
    function create(bytes32 qx, bytes32 qy, address token) external returns (address wallet) {
        wallet = addressOf(qx, qy);
        if (wallet.code.length > 0) return wallet;
        PasskeyWalletV2 w = new PasskeyWalletV2{salt: _salt(qx, qy)}(qx, qy);
        emit WalletCreated(address(w), qx, qy);
        if (token != address(0)) w.associate(token);
        return address(w);
    }

    /// @notice Where the wallet for this passkey is (or will be).
    function addressOf(bytes32 qx, bytes32 qy) public view returns (address) {
        bytes32 code =
            keccak256(abi.encodePacked(type(PasskeyWalletV2).creationCode, abi.encode(qx, qy)));
        return address(
            uint160(
                uint256(
                    keccak256(abi.encodePacked(bytes1(0xff), address(this), _salt(qx, qy), code))
                )
            )
        );
    }

    function _salt(bytes32 qx, bytes32 qy) private pure returns (bytes32) {
        return keccak256(abi.encode(qx, qy));
    }
}
