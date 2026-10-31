import { agentRecords, liveQuotes } from "@eth/arkiv";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentChecker } from "./check";
import { safeAgentUrl } from "./safe-url";

vi.mock("@eth/arkiv", () => ({
  arkivReader: vi.fn(() => ({})),
  agentRecords: vi.fn(),
  liveQuotes: vi.fn(),
}));

const AGENT = "0x4b4d1de6adff7379795243da1510ae76deb478a5";
const URL_ = "http://agent.test:8420";
const profile = {
  name: "PackPal",
  skill: "packing",
  agent: AGENT,
  price: "10000",
  inputSchema: {},
};
const records = (endpoint = URL_) => ({
  profiles: [{ key: "0xp", record: { skill: "packing", hederaAccount: "0.0.77" } }],
  listings: [{ key: "0xl", record: { skill: "packing", endpoint, priceUnits: 10000n } }],
});
// x402's PAYMENT-REQUIRED header is base64-encoded JSON.
const encodePaymentRequiredHeader = (v: unknown) =>
  Buffer.from(JSON.stringify(v)).toString("base64");
const required = (payTo = "0.0.77", amount = "10000") =>
  encodePaymentRequiredHeader({
    x402Version: 2,
    resource: { url: `${URL_}/work`, description: "", mimeType: "application/json" },
    accepts: [
      {
        scheme: "exact",
        network: "hedera:testnet",
        asset: "0.0.429274",
        amount,
        payTo,
        maxTimeoutSeconds: 120,
        extra: { executors: ["0.0.11102395"] },
      },
    ],
  });

/** A fake agent plus mirror: everything right unless a test says otherwise. */
function fakeWeb(
  o: { profile?: unknown; canHold?: boolean; quote?: boolean; payTo?: string } = {},
) {
  return vi.fn(async (url: string) => {
    if (url.startsWith("https://mirror")) {
      if (url.includes("/tokens?"))
        return Response.json({ tokens: o.canHold === false ? [] : [{}] });
      return Response.json({
        evm_address: AGENT,
        max_automatic_token_associations: o.canHold === false ? 0 : 10,
      });
    }
    if (url.endsWith("/quote"))
      return o.quote === false
        ? new Response("no", { status: 422 })
        : Response.json({ quoteKey: "0xq" });
    if (url.endsWith("/work"))
      return new Response("{}", {
        status: 402,
        headers: { "payment-required": required(o.payTo) },
      });
    return Response.json(o.profile ?? profile);
  }) as unknown as typeof fetch;
}
const checker = (fetchImpl: typeof fetch) =>
  agentChecker({
    mirrorUrl: "https://mirror",
    usdcTokenId: "0.0.429274",
    executorId: "0.0.11102395",
    production: false,
    reader: {} as never,
    fetchImpl,
  });
const marks = (r: { steps: { name: string; ok: boolean | null }[] }) =>
  r.steps.map((s) => `${s.ok === true ? "✓" : s.ok === false ? "✗" : "–"} ${s.name}`);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(agentRecords).mockResolvedValue(records() as never);
  vi.mocked(liveQuotes).mockResolvedValue([{ key: "0xq", creator: AGENT }] as never);
});

describe("agent checker", () => {
  it("an agent made with the kit passes every step", async () => {
    const r = await checker(fakeWeb())(URL_, { destination: "Goa", days: 3 });
    expect(r.live).toBe(true);
    expect(marks(r)).toEqual([
      "✓ Address",
      "✓ Profile",
      "✓ Listing on Arkiv",
      "✓ Paid to",
      "✓ Quote",
      "✓ Payment",
    ]);
    expect(r.agent).toEqual({ address: AGENT, name: "PackPal", skill: "packing" });
  });

  it("without a sample, it's live once listed and payable; quote and payment are skipped", async () => {
    const r = await checker(fakeWeb())(URL_);
    expect(r.live).toBe(true);
    expect(marks(r).at(-1)).toBe("– Quote and payment");
  });

  it("says what's wrong, and how to fix it", async () => {
    const notAgent = await checker(fakeWeb({ profile: { hello: "world" } }))(URL_);
    expect(marks(notAgent)).toEqual(["✓ Address", "✗ Profile"]);
    expect(notAgent.steps[1]?.fix).toContain("agent kit");

    vi.mocked(agentRecords).mockResolvedValueOnce(records("http://elsewhere:1") as never);
    const moved = await checker(fakeWeb())(URL_);
    expect(moved.steps[2]).toMatchObject({
      ok: false,
      detail: expect.stringContaining("http://elsewhere:1"),
    });

    const unpaid = await checker(fakeWeb({ canHold: false }))(URL_);
    expect(marks(unpaid).at(-1)).toBe("✗ Paid to");

    const wrongPayee = await checker(fakeWeb({ payTo: "0.0.666" }))(URL_, {});
    expect(wrongPayee.live).toBe(false);
    expect(marks(wrongPayee).at(-1)).toBe("✗ Payment");
  });
});

describe("agent URL guard", () => {
  const resolve = (ips: string[]) => async () => ips;
  it("allows localhost while developing, only public https in production", async () => {
    expect(await safeAgentUrl("http://localhost:8420", false)).toMatchObject({ ok: true });
    expect(await safeAgentUrl("ftp://x.example", false)).toMatchObject({ ok: false });
    expect(await safeAgentUrl("https://user:pw@x.example", false)).toMatchObject({ ok: false });
    expect(
      await safeAgentUrl("http://agent.example", true, resolve(["93.184.216.34"])),
    ).toMatchObject({ ok: false });
    expect(
      await safeAgentUrl("https://agent.example", true, resolve(["93.184.216.34"])),
    ).toMatchObject({ ok: true });
    for (const ip of [
      "127.0.0.1",
      "10.0.0.5",
      "172.20.1.1",
      "192.168.1.9",
      "169.254.169.254",
      "::1",
      "fd00::1",
      "::ffff:10.0.0.1",
    ])
      expect(await safeAgentUrl("https://agent.example", true, resolve([ip])), ip).toMatchObject({
        ok: false,
      });
    expect(await safeAgentUrl("https://127.0.0.1", true)).toMatchObject({ ok: false });
  });
});
