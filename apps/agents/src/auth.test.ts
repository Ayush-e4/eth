import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { signedHeaders, signStatement, verifySigned, verifyStatement } from "./auth";

const me = privateKeyToAccount(generatePrivateKey());
const body = JSON.stringify({ checkin: "2026-11-13", checkout: "2026-11-16" });
const reader = (h: Record<string, string>) => (name: string) => h[name];

describe("signed agent requests", () => {
  it("recovers who signed the request", async () => {
    const h = await signedHeaders(me, "POST", "/bookings/b1/change-options", body);
    expect(await verifySigned(reader(h), "POST", "/bookings/b1/change-options", body)).toBe(
      me.address,
    );
  });

  it("rejects a signature reused for another booking, action or body", async () => {
    const h = await signedHeaders(me, "POST", "/bookings/b1/cancel", body);
    await expect(verifySigned(reader(h), "POST", "/bookings/b2/cancel", body)).rejects.toThrow(
      "bad signature",
    );
    await expect(verifySigned(reader(h), "POST", "/bookings/b1/change", body)).rejects.toThrow(
      "bad signature",
    );
    await expect(verifySigned(reader(h), "POST", "/bookings/b1/cancel", "{}")).rejects.toThrow(
      "bad signature",
    );
  });

  it("rejects someone claiming to be the signer", async () => {
    const h = await signedHeaders(me, "POST", "/x", body);
    const impostor = privateKeyToAccount(generatePrivateKey()).address;
    await expect(
      verifySigned(reader({ ...h, "x-agent-address": impostor }), "POST", "/x", body),
    ).rejects.toThrow("bad signature");
  });

  it("rejects stale and unsigned requests", async () => {
    const h = await signedHeaders(me, "POST", "/x", body, Date.now() - 10 * 60_000);
    await expect(verifySigned(reader(h), "POST", "/x", body)).rejects.toThrow("expired");
    await expect(verifySigned(reader({}), "POST", "/x", body)).rejects.toThrow("unsigned");
  });
});

describe("signed statements", () => {
  const slip = {
    bookingId: "b1",
    agent: me.address,
    delegate: me.address,
    minSavingInr: 500,
    minSavingPercent: 5,
    until: "2026-11-13",
    issuedAt: 1,
  };

  it("anyone can check who signed it, whatever the key order", async () => {
    const s = await signStatement(me, "reprice-delegation", slip);
    expect(await verifyStatement("reprice-delegation", s)).toBe(true);
    const reordered = {
      ...s,
      body: Object.fromEntries(Object.entries(slip).reverse()) as typeof slip,
    };
    expect(await verifyStatement("reprice-delegation", reordered)).toBe(true);
  });

  it("fails if the limits were edited or it's passed off as another kind", async () => {
    const s = await signStatement(me, "reprice-delegation", slip);
    expect(
      await verifyStatement("reprice-delegation", { ...s, body: { ...slip, minSavingInr: 1 } }),
    ).toBe(false);
    expect(await verifyStatement("attestation", s)).toBe(false);
  });
});
