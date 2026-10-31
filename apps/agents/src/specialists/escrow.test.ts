import { createPayingFetch, type Facilitator, MirrorResolver } from "@eth/x402";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signedHeaders } from "../auth";
import { type Trip, TripSchema } from "../trip";
import { type EscrowMoves, escrowJobs, resultHash } from "./escrow";
import { type JobStore, jobStore } from "./jobs";
import { createSpecialist, type SpecialistDef } from "./server";

vi.mock("@eth/arkiv", () => ({
  arkivReader: vi.fn(() => ({})),
  arkivWriter: vi.fn(() => ({})),
  postQuote: vi.fn(async () => ({ entityKey: "0xq1", txHash: "0xt1" })),
  findListings: vi.fn(async () => []),
  publishAgent: vi.fn(async () => ({ txHash: "0xpub" })),
  recordDelivery: vi.fn(async () => ({ entityKey: "0xd1" })),
}));

const REGISTRY = "0.0.11254658";
const agentKey = generatePrivateKey();
const identity = {
  key: agentKey,
  evm: privateKeyToAccount(agentKey).address,
  hederaAccount: "0.0.5005",
};
const trip: Trip = {
  origin: "BOM",
  destination: "GOI",
  destinationName: "Goa",
  departDate: "2026-11-06",
  returnDate: "2026-11-08",
  returnFlight: true,
  nonRefundableOk: false,
  hotelWishes: "",
  adults: 1,
  budgetInr: 20000,
  notes: "",
};
const buyer = privateKeyToAccount(generatePrivateKey());

let jobs: JobStore;
let work: ReturnType<typeof vi.fn>;
let moves: {
  [K in keyof EscrowMoves]: K extends "terms" ? EscrowMoves[K] : ReturnType<typeof vi.fn>;
};
const refundFromAccount = vi.fn(async () => "0.0.5005@9.9");
beforeEach(() => {
  vi.clearAllMocks();
  jobs = jobStore();
  work = vi.fn(async (_b: unknown, d: { offerId: string }) => ({ booked: d.offerId }));
  moves = {
    terms: { deliverSeconds: 900, reviewSeconds: 900 },
    deliver: vi.fn(async () => "0.0.5005@7.7"),
    refund: vi.fn(async () => "0.0.5005@8.8"),
    claim: vi.fn(async () => "0.0.5005@6.6"),
    read: vi.fn(),
  };
});

function agent() {
  const def: SpecialistDef<Trip, { offerId: string }, { booked: string }> = {
    name: "TestHop",
    skill: "flights",
    input: TripSchema,
    title: "Cheapest flight",
    description: "test",
    priceUnits: 50_000n,
    quote: vi.fn(async () => ({
      note: "BOM→GOI",
      detail: { offerId: "off_1" },
      itemTotal: 1,
      itemCurrency: "INR",
    })),
    work: work as never,
  };
  const facilitator: Facilitator = {
    verify: async () => ({ isValid: true, payer: "0.0.1" }),
    settle: async () => ({
      success: true,
      transaction: "0.0.9@1.2",
      network: "hedera:testnet",
      payer: "0.0.1",
    }),
  };
  const s = createSpecialist(def, {
    identity,
    baseUrl: "http://agent",
    facilitator,
    usdcTokenId: "0.0.429274",
    executorId: REGISTRY,
    refund: refundFromAccount,
    escrow: moves as unknown as EscrowMoves,
    jobs,
  });
  const pay = createPayingFetch(
    {
      agent: privateKeyToAccount(generatePrivateKey()),
      mandateId: 3n,
      payer: "0.0.1",
      executor: REGISTRY,
      executorEvm: "0xc854860e659d5e70fd4e47146643abec6db634b6",
      chainId: 296,
      resolver: new MirrorResolver("https://mirror", (async () =>
        Response.json({ account: identity.hederaAccount, evm_address: identity.evm })) as never),
    },
    ((u: string, i?: RequestInit) => s.app.request(u, i)) as typeof fetch,
  );
  return {
    async hire() {
      await s.app.request("http://agent/quote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task: "trip-1", skill: "flights", input: trip }),
      });
      const body = JSON.stringify({
        task: "trip-1",
        skill: "flights",
        input: trip,
        quoteKey: "0xq1",
      });
      const signed = await signedHeaders(buyer, "POST", "/work", body);
      return pay("http://agent/work", {
        method: "POST",
        headers: { "content-type": "application/json", ...signed },
        body,
      });
    },
  };
}

describe("pay on delivery, the agent's side", () => {
  it("asks for escrow, marks the job delivered with a hash of the result, tells the buyer", async () => {
    const { response, paid } = await agent().hire();
    expect(response.status).toBe(200);
    expect(paid?.escrowId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await response.json()).toMatchObject({
      status: "delivered",
      escrow: { id: paid?.escrowId, deliveredTx: "0.0.5005@7.7" },
    });
    expect(moves.deliver).toHaveBeenCalledWith(paid?.escrowId, resultHash({ booked: "off_1" }));
    const job = jobs.job("0xq1");
    expect(job?.escrow).toEqual({ id: paid?.escrowId, deliveredTx: "0.0.5005@7.7" });
    // the buyer signed the escrow form: deliver-by leaves the agent its 15 minutes
    expect(job?.payment.mandateId).toBe("3");
  });

  it("a failed job is refunded from the escrow, which restores the buyer's limit", async () => {
    work.mockRejectedValueOnce(new Error("sold out"));
    const { response } = await agent().hire();
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ refund: { transaction: "0.0.5005@8.8" } });
    expect(moves.refund).toHaveBeenCalledOnce();
    expect(refundFromAccount).not.toHaveBeenCalled(); // not from the agent's own account
    expect(jobs.job("0xq1")?.escrow?.closed).toBe("refunded");
    expect(jobs.openEscrows()).toEqual([]);
  });

  it("the sweep retries a missed delivery, then claims what the buyer didn't release", async () => {
    moves.deliver.mockRejectedValueOnce(new Error("network blip"));
    const { response } = await agent().hire();
    expect(response.status).toBe(200); // the buyer still gets its result
    const esc = escrowJobs(moves as unknown as EscrowMoves, jobs, () => {});
    await esc.sweep();
    expect(jobs.job("0xq1")?.escrow?.deliveredTx).toBe("0.0.5005@7.7");

    const now = Date.now();
    const deliveredAt = BigInt(Math.floor(now / 1000) - 600);
    moves.read.mockResolvedValue({ state: "delivered", deliveredAt, reviewSeconds: 900 });
    await esc.sweep(now); // still in the buyer's review window
    expect(moves.claim).not.toHaveBeenCalled();
    await esc.sweep(now + 301_000);
    expect(moves.claim).toHaveBeenCalledWith(jobs.job("0xq1")?.escrow?.id);
    expect(jobs.job("0xq1")?.escrow).toMatchObject({ closed: "paid", claimTx: "0.0.5005@6.6" });
    expect(jobs.openEscrows()).toEqual([]);
  });

  it("released by the buyer: closed, nothing to claim", async () => {
    await agent().hire();
    moves.read.mockResolvedValue({ state: "released", deliveredAt: 1n, reviewSeconds: 900 });
    await escrowJobs(moves as unknown as EscrowMoves, jobs, () => {}).sweep();
    expect(moves.claim).not.toHaveBeenCalled();
    expect(jobs.job("0xq1")?.escrow?.closed).toBe("paid");
  });

  it("disputed by the buyer: the agent gives the fee back", async () => {
    await agent().hire();
    moves.read.mockResolvedValue({ state: "disputed", deliveredAt: 1n, reviewSeconds: 900 });
    await escrowJobs(moves as unknown as EscrowMoves, jobs, () => {}).sweep();
    expect(moves.refund).toHaveBeenCalledWith(jobs.job("0xq1")?.escrow?.id);
    expect(jobs.job("0xq1")).toMatchObject({
      status: "delivered",
      refund: { transaction: "0.0.5005@8.8" },
      escrow: { closed: "refunded" },
    });
  });
});
