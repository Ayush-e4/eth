import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Abi, toFunctionSelector } from "viem";
import { describe, expect, it } from "vitest";
import {
  assertionFromWebAuthn,
  passkeyWalletAbi,
  passkeyWalletFactoryAbi,
  passkeyWalletV2Abi,
} from "./passkey-wallet";

const compiledAbi = (name: string) =>
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../../contracts/out/${name}.sol/${name}.json`, import.meta.url)),
      "utf8",
    ),
  ).abi as Abi;
const fns = (abi: Abi) =>
  abi.filter((i) => i.type === "function").map((i) => toFunctionSelector(i as never));

describe("passkey wallet ABIs match the compiled contracts", () => {
  it.each([
    ["PasskeyWallet", passkeyWalletAbi],
    ["PasskeyWalletFactory", passkeyWalletFactoryAbi],
    ["PasskeyWalletV2", passkeyWalletV2Abi],
    ["PasskeyWalletFactoryV2", passkeyWalletFactoryAbi],
  ] as const)("%s", (name, ours) => {
    const compiled = new Set(fns(compiledAbi(name)));
    for (const sel of fns(ours as Abi)) expect(compiled.has(sel), sel).toBe(true);
  });
});

describe("assertionFromWebAuthn", () => {
  it("takes r and s out of the DER signature, low s, and finds type and challenge", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const authData = Buffer.concat([Buffer.alloc(32, 7), Buffer.from([5, 0, 0, 0, 1])]);
    const client = Buffer.from(
      JSON.stringify({ type: "webauthn.get", challenge: "abc", origin: "http://localhost:3000" }),
    );
    const msg = Buffer.concat([authData, createHash("sha256").update(client).digest()]);
    for (let i = 0; i < 8; i++) {
      const der = sign("sha256", msg, privateKey);
      const a = assertionFromWebAuthn({
        authenticatorData: authData.toString("base64url"),
        clientDataJSON: client.toString("base64url"),
        signature: der.toString("base64url"),
      });
      expect(BigInt(a.s) <= 0x7fffffff800000007fffffffffffffffde737d56d38bcf4279dce5617e3192a8n);
      // r || s (P1363) still verifies after the flip
      const p1363 = Buffer.from(a.r.slice(2) + a.s.slice(2), "hex");
      expect(verify("sha256", msg, { key: publicKey, dsaEncoding: "ieee-p1363" }, p1363)).toBe(
        true,
      );
      expect(a.clientDataJSON.slice(Number(a.typeIndex))).toMatch(/^"type":"webauthn.get"/);
      expect(a.clientDataJSON.slice(Number(a.challengeIndex))).toMatch(/^"challenge":"abc"/);
      expect(a.authenticatorData).toBe(`0x${authData.toString("hex")}`);
    }
  });
});
