import { encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { mandateRegistryAbi } from "./abi";
import { decodeX402Authorization, paymentState } from "./paid";
import { encodeX402Authorization } from "./signing";

const auth = {
  mandateId: 43n,
  payTo: "0x0000000000000000000000000000000000000001" as const,
  amount: 30_000n,
  nonce: 777n,
  validBefore: 2_000_000_000n,
};

describe("decodeX402Authorization", () => {
  it("reads back what encodeX402Authorization wrote", () => {
    const bytes = encodeX402Authorization(auth, "0x1234");
    expect(decodeX402Authorization(bytes)).toEqual({
      mandateId: 43n,
      nonce: 777n,
      validBefore: 2_000_000_000n,
      signature: "0x1234",
    });
  });
});

describe("paymentState", () => {
  const topics = encodeEventTopics({
    abi: mandateRegistryAbi,
    eventName: "Paid",
    args: { mandateId: 43n, payTo: auth.payTo },
  }) as Hex[];
  const log = (nonce: bigint) => ({
    topics,
    data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [30_000n, nonce]),
    timestamp: "1793446527.007072821",
  });
  const deps = (used: boolean) => {
    const urls: string[] = [];
    return {
      urls,
      d: {
        evm: { readContract: async () => used } as never,
        registry: "0x2f30e8F1804Fe163C76918db493a441D44394D5d" as const,
        registryId: "0.0.11102395",
        mirrorUrl: "https://mirror",
        fetchImpl: (async (u: string) => {
          urls.push(u);
          return u.includes("/logs")
            ? Response.json({ logs: [log(1n), log(777n)] })
            : Response.json({
                transactions: [
                  { transaction_id: "0.0.11045937-1793446462-881862945", scheduled: true },
                ],
              });
        }) as unknown as typeof fetch,
      },
    };
  };

  it("paid: the nonce is used, and the mirror finds the payment's transaction", async () => {
    const { d, urls } = deps(true);
    expect(await paymentState(d, auth)).toEqual({
      state: "paid",
      transaction: "0.0.11045937@1793446462.881862945?scheduled",
    });
    expect(urls[0]).toContain(`topic1=${topics[1]}`);
    expect(urls[0]).toContain("timestamp=gte:1999999100&timestamp=lte:2000000030");
    expect(urls[1]).toContain("timestamp=1793446527.007072821");
  });

  it("pending while the authorization can still pay; unpaid once it has expired", async () => {
    const { d } = deps(false);
    const before = Number(auth.validBefore) * 1000 - 1_000;
    const after = Number(auth.validBefore) * 1000 + 60_000;
    expect(await paymentState(d, auth, before)).toEqual({ state: "pending" });
    expect(await paymentState(d, auth, after)).toEqual({ state: "unpaid" });
  });
});
