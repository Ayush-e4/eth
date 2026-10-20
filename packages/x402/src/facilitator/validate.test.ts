import { describe, expect, it } from "vitest";
import type { PaymentPayload, PaymentRequirements } from "../types";
import { validateExecutorPayment } from "./validate";

const ctx = { network: "hedera:testnet" as const, admittedExecutors: ["0.0.11102395"] };
const req: PaymentRequirements = {
  scheme: "exact",
  network: "hedera:testnet",
  asset: "0.0.429274",
  amount: "50000",
  payTo: "0.0.11102187",
  maxTimeoutSeconds: 120,
  extra: { assetTransferMethod: "transferExecutor", executors: ["0.0.11102395"] },
};
const payment = (
  over: Partial<PaymentPayload> = {},
  payload: Record<string, unknown> = {},
): PaymentPayload => ({
  x402Version: 2,
  accepted: req,
  payload: { payer: "0.0.11045937", executor: "0.0.11102395", authorization: "0xabcd", ...payload },
  ...over,
});
const reason = (p: PaymentPayload, r = req) => {
  const v = validateExecutorPayment(p, r, ctx);
  return v.isValid ? "ok" : v.invalidReason;
};

describe("validateExecutorPayment", () => {
  it("accepts a well-formed payment", () => expect(reason(payment())).toBe("ok"));
  it("rejects other x402 versions", () =>
    expect(reason(payment({ x402Version: 1 }))).toBe("invalid_x402_version"));
  it("rejects the wrong network", () =>
    expect(reason(payment(), { ...req, network: "hedera:mainnet" })).toBe("invalid_network"));
  it("rejects HBAR (registry moves tokens only)", () =>
    expect(
      reason(payment({ accepted: { ...req, asset: "0.0.0" } }), { ...req, asset: "0.0.0" }),
    ).toBe("invalid_payment_requirements"));
  it("rejects accepted terms that differ from the quote", () =>
    expect(reason(payment({ accepted: { ...req, amount: "1" } }))).toBe("invalid_payload"));
  it("rejects cryptoTransfer (not implemented here)", () => {
    const accepted = { ...req, extra: {} };
    expect(reason(payment({ accepted }), { ...req, extra: {} })).toBe(
      "invalid_exact_hedera_unsupported_asset_transfer_method",
    );
  });
  it("rejects a malformed payer", () =>
    expect(reason(payment({}, { payer: "alice" }))).toBe("invalid_exact_hedera_payload_payer"));
  it("rejects non-hex authorization", () =>
    expect(reason(payment({}, { authorization: "nope" }))).toBe(
      "invalid_exact_hedera_payload_authorization",
    ));
  it("rejects an executor we don't admit", () =>
    expect(reason(payment({}, { executor: "0.0.666" }))).toBe(
      "invalid_exact_hedera_executor_not_admitted",
    ));
});
