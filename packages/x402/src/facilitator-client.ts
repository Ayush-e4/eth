import type { SettleResponse, VerifyResponse } from "@x402/core/types";
import { type PaymentPayload, type PaymentRequirements, X402_VERSION } from "./types";

/** What a resource server needs from a facilitator. */
export interface Facilitator {
  verify(p: PaymentPayload, r: PaymentRequirements): Promise<VerifyResponse>;
  settle(p: PaymentPayload, r: PaymentRequirements): Promise<SettleResponse>;
}

/** Talks to a facilitator over HTTP (POST /verify, POST /settle — x402 v2 bodies). */
export class HttpFacilitator implements Facilitator {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async post<T>(path: string, p: PaymentPayload, r: PaymentRequirements): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        x402Version: X402_VERSION,
        paymentPayload: p,
        paymentRequirements: r,
      }),
    });
    if (!res.ok) throw new Error(`facilitator ${path} → HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  verify(p: PaymentPayload, r: PaymentRequirements) {
    return this.post<VerifyResponse>("/verify", p, r);
  }

  settle(p: PaymentPayload, r: PaymentRequirements) {
    return this.post<SettleResponse>("/settle", p, r);
  }
}
