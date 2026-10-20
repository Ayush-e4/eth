import { decodeAbiParameters, recoverTypedDataAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { tokenIdToEvmAddress } from "./chain";
import {
  encodeX402Authorization,
  hashPayees,
  mandateDomain,
  paymentAuthTypes,
  randomNonce,
  signPaymentAuth,
} from "./signing";

const registry = "0x2f30e8F1804Fe163C76918db493a441D44394D5d";
const agent = privateKeyToAccount(generatePrivateKey());
const auth = {
  mandateId: 1n,
  payTo: "0x000000000000000000000000000000000000dEaD",
  amount: 1_000_000n,
  nonce: 42n,
  validBefore: 9_999_999_999n,
} as const;

describe("payment signatures", () => {
  it("recover to the signing agent", async () => {
    const domain = mandateDomain(296, registry);
    const signature = await signPaymentAuth(agent, domain, auth);
    const signer = await recoverTypedDataAddress({
      domain,
      types: paymentAuthTypes,
      primaryType: "PaymentAuth",
      message: auth,
      signature,
    });
    expect(signer).toBe(agent.address);
  });

  it("differ per chain, so a testnet signature can't be replayed on mainnet", async () => {
    const a = await signPaymentAuth(agent, mandateDomain(296, registry), auth);
    const b = await signPaymentAuth(agent, mandateDomain(295, registry), auth);
    expect(a).not.toBe(b);
  });

  it("encode into the x402 authorization the contract decodes", async () => {
    const signature = await signPaymentAuth(agent, mandateDomain(296, registry), auth);
    const [id, nonce, validBefore, sig] = decodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes" }],
      encodeX402Authorization(auth, signature),
    );
    expect([id, nonce, validBefore, sig]).toEqual([1n, 42n, 9_999_999_999n, signature]);
  });
});

describe("helpers", () => {
  it("hashes payees like abi.encodePacked(address[])", () => {
    expect(hashPayees([])).toBe(
      "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
    );
  });

  it("random nonces don't repeat", () => {
    expect(randomNonce()).not.toBe(randomNonce());
  });

  it("maps HTS token ids to ERC-20 facade addresses", () => {
    expect(tokenIdToEvmAddress("0.0.429274")).toBe("0x0000000000000000000000000000000000068cda");
  });
});
