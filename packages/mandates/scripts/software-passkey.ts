// A software passkey for the demos: a P-256 key standing in for a phone's Face ID, answering a
// challenge the way a browser's WebAuthn does (for http://localhost:3000).
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import type { Hex } from "viem";
import { type Assertion, assertionFromWebAuthn, type PasskeyKey } from "../src";

const sha = (b: Buffer) => createHash("sha256").update(b).digest();

export function softwarePasskey(): PasskeyKey & { faceId: (challenge: Hex) => Assertion } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  let counter = 0;
  return {
    qx: `0x${Buffer.from(jwk.x ?? "", "base64url").toString("hex")}` as Hex,
    qy: `0x${Buffer.from(jwk.y ?? "", "base64url").toString("hex")}` as Hex,
    faceId(challenge) {
      const authenticatorData = Buffer.concat([
        sha(Buffer.from("localhost")),
        Buffer.from([0x05, 0, 0, 0, ++counter]),
      ]);
      const clientDataJSON = Buffer.from(
        JSON.stringify({
          type: "webauthn.get",
          challenge: Buffer.from(challenge.slice(2), "hex").toString("base64url"),
          origin: "http://localhost:3000",
          crossOrigin: false,
        }),
      );
      const signature = sign(
        "sha256",
        Buffer.concat([authenticatorData, sha(clientDataJSON)]),
        privateKey,
      );
      return assertionFromWebAuthn({
        authenticatorData: authenticatorData.toString("base64url"),
        clientDataJSON: clientDataJSON.toString("base64url"),
        signature: signature.toString("base64url"),
      });
    },
  };
}
