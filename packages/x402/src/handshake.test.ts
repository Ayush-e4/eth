import { mandateDomain, paymentAuthTypes } from "@eth/mandates";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { SettleResponse, VerifyResponse } from "@x402/core/types";
import { Hono } from "hono";
import { decodeAbiParameters, recoverTypedDataAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { createPayingFetch } from "./client";
import type { Facilitator } from "./facilitator-client";
import { paywall } from "./paywall";
import { MirrorResolver } from "./resolve";
import { type PaymentPayload, type PaymentRequirements, paymentKey } from "./types";

const REGISTRY = "0.0.11102395";
const REGISTRY_EVM = "0x2f30e8F1804Fe163C76918db493a441D44394D5d";
const SHOP = "0.0.11102187";
const SHOP_EVM = "0xf690e2189f16441aff2510b2f7da456abd6e22d5";
const agent = privateKeyToAccount(generatePrivateKey());

/** Records what the paywall sent and approves everything. */
class FakeFacilitator implements Facilitator {
  seen: PaymentPayload[] = [];
  async verify(p: PaymentPayload): Promise<VerifyResponse> {
    this.seen.push(p);
    return { isValid: true, payer: "0.0.1" };
  }
  async settle(): Promise<SettleResponse> {
    return { success: true, transaction: "0.0.9@1.2", network: "hedera:testnet", payer: "0.0.1" };
  }
}

function setup(facilitator: Facilitator = new FakeFacilitator()) {
  const app = new Hono();
  app.get(
    "/plan",
    paywall({
      network: "hedera:testnet",
      asset: "0.0.429274",
      amount: "50000",
      payTo: SHOP,
      executors: [REGISTRY],
      facilitator,
    }),
    (c) => c.json({ plan: "Goa: beach, then dinner" }),
  );
  const appFetch = ((url: string, init?: RequestInit) => app.request(url, init)) as typeof fetch;
  const mirrorFetch = (async () =>
    Response.json({ account: SHOP, evm_address: SHOP_EVM })) as unknown as typeof fetch;
  const pay = createPayingFetch(
    {
      agent,
      mandateId: 7n,
      payer: "0.0.1",
      executor: REGISTRY,
      executorEvm: REGISTRY_EVM,
      chainId: 296,
      resolver: new MirrorResolver("https://mirror", mirrorFetch),
      maxAmount: 100_000n,
    },
    appFetch,
  );
  return { app, pay };
}

describe("x402 handshake", () => {
  it("answers 402 with spec-shaped requirements when unpaid", async () => {
    const res = await setup().app.request("http://x/plan");
    expect(res.status).toBe(402);
    const required = decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED") ?? "");
    const req = required.accepts[0] as PaymentRequirements;
    expect(req).toMatchObject({
      scheme: "exact",
      network: "hedera:testnet",
      amount: "50000",
      payTo: SHOP,
    });
    expect(req.extra).toEqual({ assetTransferMethod: "transferExecutor", executors: [REGISTRY] });
  });

  it("agent pays automatically and gets the resource + receipt", async () => {
    const facilitator = new FakeFacilitator();
    const { response, paid } = await setup(facilitator).pay("http://x/plan");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ plan: "Goa: beach, then dinner" });
    expect(paid?.settlement.transaction).toBe("0.0.9@1.2");
    expect(facilitator.seen[0]?.payload).toMatchObject({ payer: "0.0.1", executor: REGISTRY });
  });

  it("the authorization is the agent's signature over exactly the quoted payment", async () => {
    const facilitator = new FakeFacilitator();
    await setup(facilitator).pay("http://x/plan");
    const auth = facilitator.seen[0]?.payload.authorization as `0x${string}`;
    const [mandateId, nonce, validBefore, signature] = decodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes" }],
      auth,
    );
    const signer = await recoverTypedDataAddress({
      domain: mandateDomain(296, REGISTRY_EVM),
      types: paymentAuthTypes,
      primaryType: "PaymentAuth",
      message: { mandateId, payTo: SHOP_EVM, amount: 50_000n, nonce, validBefore },
      signature,
    });
    expect(signer).toBe(agent.address);
  });

  it("returns 402 with the facilitator's reason when settlement fails", async () => {
    const failing: Facilitator = {
      verify: async () => ({ isValid: true }),
      settle: async () => ({
        success: false,
        errorReason: "simulation_reverted",
        transaction: "",
        network: "hedera:testnet",
      }),
    };
    const { response } = await setup(failing).pay("http://x/plan");
    expect(response.status).toBe(402);
    expect(((await response.json()) as { error?: string }).error).toBe("simulation_reverted");
  });

  it("asks for an undo window and reports the payment's key once signed", async () => {
    const facilitator = new FakeFacilitator();
    const { app } = setup(facilitator);
    const keys: string[] = [];
    const pay = createPayingFetch(
      {
        agent,
        mandateId: 7n,
        payer: "0.0.1",
        executor: REGISTRY,
        executorEvm: REGISTRY_EVM,
        chainId: 296,
        resolver: new MirrorResolver("https://mirror", (async () =>
          Response.json({ account: SHOP, evm_address: SHOP_EVM })) as unknown as typeof fetch),
        maxAmount: 100_000n,
        undoSeconds: 45,
        onSigned: (k) => keys.push(k),
      },
      ((u: string, i?: RequestInit) => app.request(u, i)) as typeof fetch,
    );
    await pay("http://x/plan");
    const sent = facilitator.seen[0] as PaymentPayload;
    expect(sent.extensions).toEqual({ undoWindow: { seconds: 45 } });
    expect(keys).toEqual([
      paymentKey("hedera:testnet", REGISTRY, "0.0.1", sent.payload.authorization as `0x${string}`),
    ]);
  });

  it("refuses to sign above the agent's per-call limit", async () => {
    const { app } = setup();
    const pricey = createPayingFetch(
      {
        agent,
        mandateId: 7n,
        payer: "0.0.1",
        executor: REGISTRY,
        executorEvm: REGISTRY_EVM,
        chainId: 296,
        resolver: new MirrorResolver("https://mirror"),
        maxAmount: 10_000n,
      },
      ((u: string, i?: RequestInit) => app.request(u, i)) as typeof fetch,
    );
    await expect(pricey("http://x/plan")).rejects.toThrow(/per-call limit/);
  });
});
