import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";

const b64 = (b: Uint8Array) => isoBase64URL.fromBuffer(new Uint8Array(b));
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest();
const u32 = (n: number) => Buffer.from([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

/**
 * A software passkey for tests: what Face ID does, minus the face. Makes a P-256 key, answers
 * registration and sign-in challenges with real signatures in the browser's JSON format.
 */
export function softPasskey(origin: string) {
  const rpID = new URL(origin).hostname;
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const id = randomBytes(16);
  let counter = 0;

  const authData = (extra: Buffer, flags: number) =>
    Buffer.concat([sha256(rpID), Buffer.from([flags]), u32(counter), extra]);
  const clientData = (type: string, challenge: string) =>
    Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));

  return {
    id: b64(id),

    register(challenge: string) {
      const cose = isoCBOR.encode(
        new Map<number, number | Uint8Array>([
          [1, 2], // EC2
          [3, -7], // ES256
          [-1, 1], // P-256
          [-2, isoBase64URL.toBuffer(jwk.x ?? "")],
          [-3, isoBase64URL.toBuffer(jwk.y ?? "")],
        ]),
      );
      const credData = Buffer.concat([Buffer.alloc(16), Buffer.from([0, id.length]), id, cose]);
      const attestationObject = isoCBOR.encode(
        new Map<string, unknown>([
          ["fmt", "none"],
          ["attStmt", new Map<string, never>()],
          ["authData", new Uint8Array(authData(credData, 0x45))], // present + verified + key
        ]) as never,
      );
      return {
        id: b64(id),
        rawId: b64(id),
        type: "public-key" as const,
        response: {
          clientDataJSON: b64(clientData("webauthn.create", challenge)),
          attestationObject: b64(attestationObject),
          transports: ["internal"],
        },
        clientExtensionResults: {},
      };
    },

    signIn(challenge: string) {
      counter += 1;
      const data = authData(Buffer.alloc(0), 0x05);
      const client = clientData("webauthn.get", challenge);
      const signature = sign("sha256", Buffer.concat([data, sha256(client)]), privateKey);
      return {
        id: b64(id),
        rawId: b64(id),
        type: "public-key" as const,
        response: {
          clientDataJSON: b64(client),
          authenticatorData: b64(data),
          signature: b64(signature),
        },
        clientExtensionResults: {},
      };
    },
  };
}
