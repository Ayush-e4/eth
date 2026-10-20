// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/// @notice Feasibility probe for the MandateRegistry design on Hedera EVM. It checks that
///   (1) a contract can verify an agent's EIP-712 signature, and
///   (2) a contract can move an HTS token (USDC) the owner approved, via its ERC-20 facade.
/// @dev Not part of the product. MandateRegistry will build on whatever this proves.
contract HederaProbe is EIP712 {
    /// What an agent signs to authorise one payment.
    struct PaymentAuth {
        address payTo;
        uint256 amount;
        uint256 nonce;
        uint256 validBefore;
    }

    bytes32 public constant PAYMENT_AUTH_TYPEHASH = keccak256(
        "PaymentAuth(address payTo,uint256 amount,uint256 nonce,uint256 validBefore)"
    );

    address public immutable owner;

    error NotOwner();

    constructor() EIP712("eth-probe", "1") {
        owner = msg.sender;
    }

    /// @notice EIP-712 digest for a payment authorisation (what the wallet actually signs).
    function digest(PaymentAuth calldata a) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(PAYMENT_AUTH_TYPEHASH, a.payTo, a.amount, a.nonce, a.validBefore))
        );
    }

    /// @notice Returns the address that signed `a`. Check (1).
    function recoverSigner(PaymentAuth calldata a, bytes calldata signature)
        external
        view
        returns (address)
    {
        return ECDSA.recover(digest(a), signature);
    }

    /// @notice Moves `amount` of `token` from `from` to `to` using an allowance `from` granted
    ///   to this contract. Check (2). Owner-only so nobody else can spend the probe's allowance.
    function pull(IERC20 token, address from, address to, uint256 amount) external {
        if (msg.sender != owner) revert NotOwner();
        // Intentional: `from` is chosen by the owner; the allowance `from` granted bounds it.
        // forge-lint: disable-next-line(arbitrary-send-erc20)
        require(token.transferFrom(from, to, amount), "transferFrom failed");
    }
}
