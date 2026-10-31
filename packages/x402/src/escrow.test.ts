import {
  decodeX402EscrowAuthorization,
  encodeX402EscrowAuthorization,
  escrowAuthTypes,
  escrowIdOf,
  mandateDomain,
} from "@eth/mandates";
import type { SettleResponse, VerifyResponse } from "@x402/core/types";
import { Hono } from "hono";
import { recoverTypedDataAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { createPayingFetch } from "./client";
import { escrowTerms } from "./facilitator/validate";
import type { Facilitator } from "./facilitator-client";
import { paywall } from "./paywall";
import { MirrorResolver } from "./resolve";
import type { PaymentPayload, PaymentRequirements } from "./types";

const REGISTRY = "0.0.11254658";
const REGISTRY_EVM = "0xc854860e659d5e70fd4e47146643abec6db634b6";
const SHOP = "0.0.11102187";
const SHOP_EVM = "0xf690e2189f16441aff2510b2f7da456abd6e22d5";
const TERMS = { deliverSeconds: 600, reviewSeconds: 120 };
const agent = privateKeyToAccount(generatePrivateKey());

class FakeFacilitator implements Facilitator {
  seen: { p: PaymentPayload; req: PaymentRequirements }[] = [];
  async verify(p: PaymentPayload, req: PaymentRequirements): Promise<VerifyResponse> {
    this.seen.push({ p, req });
    return { isValid: true, payer: "0.0.1" };
  }
  async settle(): Promise<SettleResponse> {
    return { success: true, transaction: "0.0.9@1.2", network: "hedera:testnet", payer: "0.0.1" };
  }
}

function setup() {
  const facilitator = new FakeFacilitator();
  const app = new Hono();
  app.post(
    "/work",
    paywall({
      network: "hedera:testnet",
      asset: "0.0.429274",
      amount: "10000",
      payTo: SHOP,
      executors: [REGISTRY],
      facilitator,
      escrow: TERMS,
    }),
    (c) => c.json({ result: "packing list" }),
  );
  const pay = createPayingFetch(
    {
      agent,
      mandateId: 3n,
      payer: "0.0.1",
      executor: REGISTRY,
      executorEvm: REGISTRY_EVM,
      chainId: 296,
      resolver: new MirrorResolver("https://mirror", (async () =>
        Response.json({ account: SHOP, evm_address: SHOP_EVM })) as unknown as typeof fetch),
      undoSeconds: 30,
    },
    ((u: string, i?: RequestInit) => app.request(u, i)) as typeof fetch,
  );
  return { facilitator, pay };
}

describe("pay on delivery over x402", () => {
  it("the agent asks for escrow; the buyer signs an EscrowAuth on its terms", async () => {
    const { facilitator, pay } = setup();
    const { response, paid } = await pay("http://x/work", { method: "POST" });
    expect(response.status).toBe(200);
    const { p, req } = facilitator.seen[0] as (typeof facilitator.seen)[0];
    expect(req.extra).toMatchObject({ escrow: TERMS });
    const a = decodeX402EscrowAuthorization(p.payload.authorization as `0x${string}`);
    // time to deliver counts from the latest the payment can run (undo window included)
    expect(a.deliverBy).toBe(a.validBefore + 600n);
    expect(a.reviewSeconds).toBe(120);
    const signer = await recoverTypedDataAddress({
      domain: mandateDomain(296, REGISTRY_EVM),
      types: escrowAuthTypes,
      primaryType: "EscrowAuth",
      message: { ...a, payTo: SHOP_EVM, amount: 10_000n },
      signature: a.signature,
    });
    expect(signer).toBe(agent.address);
    expect(paid?.escrowId).toBe(escrowIdOf(3n, a.nonce));
    expect(escrowTerms(req, p.payload.authorization as `0x${string}`)).toEqual({
      isValid: true,
      escrow: true,
    });
  });

  it("the facilitator holds the buyer to the payee's terms", async () => {
    const { facilitator, pay } = setup();
    await pay("http://x/work", { method: "POST" });
    const { p, req } = facilitator.seen[0] as (typeof facilitator.seen)[0];
    const a = decodeX402EscrowAuthorization(p.payload.authorization as `0x${string}`);
    const resign = (e: Partial<typeof a>) =>
      encodeX402EscrowAuthorization({ ...a, ...e, payTo: SHOP_EVM, amount: 10_000n }, a.signature);
    expect(escrowTerms(req, resign({ reviewSeconds: 3600 }))).toMatchObject({
      invalidReason: "invalid_exact_hedera_escrow_terms",
    });
    expect(escrowTerms(req, resign({ deliverBy: a.validBefore + 10n }))).toMatchObject({
      invalidReason: "invalid_exact_hedera_escrow_terms",
    });
    expect(escrowTerms(req, "0x1234")).toMatchObject({
      invalidReason: "invalid_exact_hedera_payload_authorization",
    });
    const direct = { ...req, extra: { assetTransferMethod: "transferExecutor", executors: [] } };
    expect(escrowTerms(direct, "0x1234")).toEqual({ isValid: true, escrow: false });
  });
});
