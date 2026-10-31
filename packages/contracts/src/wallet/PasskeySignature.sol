// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Bytes} from "@openzeppelin/contracts/utils/Bytes.sol";
import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";

/// @title PasskeySignature
/// @notice Checks a passkey (WebAuthn) signature on-chain: what a phone's Face ID or a laptop's
///   fingerprint reader produces when a site asks it to sign a challenge.
/// @dev Hedera has no P-256 precompile (RIP-7212), so this calls OpenZeppelin's pure-Solidity
///   verifier directly instead of `P256.verify`, which probes address 0x100 first. Checks, per
///   WebAuthn level 2 "verifying an assertion": type is webauthn.get (step 11), the challenge is
///   ours (12), user present and verified (16, 17), and the P-256 signature (20). Origin and
///   RP id are the device's job; `s` must be low (the app flips a high `s` before sending).
library PasskeySignature {
    struct Assertion {
        bytes32 r;
        bytes32 s;
        uint256 challengeIndex; // where "challenge":"…" starts in clientDataJSON
        uint256 typeIndex; // where "type":"webauthn.get" starts in clientDataJSON
        bytes authenticatorData;
        string clientDataJSON;
    }

    bytes1 private constant USER_PRESENT = 0x01;
    bytes1 private constant USER_VERIFIED = 0x04;

    function verify(bytes32 challenge, Assertion memory a, bytes32 qx, bytes32 qy)
        internal
        view
        returns (bool)
    {
        if (a.authenticatorData.length < 37) return false;
        bytes1 flags = a.authenticatorData[32];
        if (flags & USER_PRESENT == 0 || flags & USER_VERIFIED == 0) return false;
        bytes memory client = bytes(a.clientDataJSON);
        if (!_at(client, a.typeIndex, bytes('"type":"webauthn.get"'))) return false;
        bytes memory expected =
            abi.encodePacked('"challenge":"', Base64.encodeURL(abi.encodePacked(challenge)), '"');
        if (!_at(client, a.challengeIndex, expected)) return false;
        bytes32 h = sha256(abi.encodePacked(a.authenticatorData, sha256(client)));
        return P256.verifySolidity(h, a.r, a.s, qx, qy);
    }

    function _at(bytes memory haystack, uint256 i, bytes memory needle)
        private
        pure
        returns (bool)
    {
        return i + needle.length <= haystack.length
            && Bytes.equal(Bytes.slice(haystack, i, i + needle.length), needle);
    }
}
