// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IMandateRegistry} from "./IMandateRegistry.sol";

/// @notice EIP-712 hashing and signature checks for MandateRegistry.
/// Agents sign typed, human-readable messages; changing any field breaks the signature.
abstract contract MandateSignatures is EIP712, IMandateRegistry {
    bytes32 public constant PAYMENT_AUTH_TYPEHASH = keccak256(
        "PaymentAuth(uint256 mandateId,address payTo,uint256 amount,uint256 nonce,uint256 validBefore)"
    );

    bytes32 public constant SUB_MANDATE_AUTH_TYPEHASH = keccak256(
        "SubMandateAuth(uint256 parentId,address agent,uint128 budget,uint128 perPaymentCap,uint64 expiresAt,bytes32 payeesHash,uint256 nonce,uint256 validBefore)"
    );

    bytes32 public constant ESCROW_AUTH_TYPEHASH = keccak256(
        "EscrowAuth(uint256 mandateId,address payTo,uint256 amount,uint256 nonce,uint256 validBefore,uint64 deliverBy,uint32 reviewSeconds)"
    );

    constructor() EIP712("MandateRegistry", "1") {}

    function escrowDigest(EscrowAuth memory a) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    ESCROW_AUTH_TYPEHASH,
                    a.mandateId,
                    a.payTo,
                    a.amount,
                    a.nonce,
                    a.validBefore,
                    a.deliverBy,
                    a.reviewSeconds
                )
            )
        );
    }

    function paymentDigest(PaymentAuth memory a) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    PAYMENT_AUTH_TYPEHASH, a.mandateId, a.payTo, a.amount, a.nonce, a.validBefore
                )
            )
        );
    }

    function subMandateDigest(SubMandateAuth memory a) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    SUB_MANDATE_AUTH_TYPEHASH,
                    a.parentId,
                    a.agent,
                    a.budget,
                    a.perPaymentCap,
                    a.expiresAt,
                    a.payeesHash,
                    a.nonce,
                    a.validBefore
                )
            )
        );
    }

    /// @dev Accepts EOA signatures and ERC-1271 smart-account signatures.
    function _requireSignedBy(address signer, bytes32 digest, bytes memory signature)
        internal
        view
    {
        if (!SignatureChecker.isValidSignatureNow(signer, digest, signature)) {
            revert BadSignature();
        }
    }
}
