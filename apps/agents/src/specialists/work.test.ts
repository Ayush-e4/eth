import { postQuote, recordDelivery } from "@eth/arkiv";
import { createPayingFetch, type Facilitator, MirrorResolver } from "@eth/x402";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signedHeaders } from "../auth";
import { type Trip, TripSchema } from "../trip";
import { type JobStore, jobStore } from "./jobs";
import { createSpecialist, type SpecialistContext, type SpecialistDef } from "./server";

vi.mock("@eth/arkiv", () => ({
  arkivReader: vi.fn(() => ({})),
  arkivWriter: vi.fn(() => ({})),
  postQuote: vi.fn(async () => ({ entityKey: "0xq1", txHash: "0xt1" })),
  findListings: vi.fn(async () => []),
  publishAgent: vi.fn(async () => ({ txHash: "0xpub" })),
  recordDelivery: vi.fn(async () => ({ entityKey: "0xd1" })),
}));

const REGISTRY = "0.0.11102395";
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
const stranger = privateKeyToAccount(generatePrivateKey());
const settled = {
  success: true,
  transaction: "0.0.9@1.2",
  network: "hedera:testnet" as const,
  payer: "0.0.1",
};

let jobs: JobStore;
let work: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks();
  jobs = jobStore();
  work = vi.fn(async (_b: unknown, d: { offerId: string }) => ({ booked: d.offerId }));
});

/** An agent on the shared job store; `extra` lets a test break the facilitator or the chain. */
function agent(extra: Partial<SpecialistContext> & { settle?: Facilitator["settle"] } = {}) {
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
    settle: extra.settle ?? (async () => settled),
  };
  const s = createSpecialist(def, {
    identity,
    baseUrl: "http://agent",
    facilitator,
    usdcTokenId: "0.0.429274",
    executorId: REGISTRY,
    refund: async () => "0.0.5005@9.9",
    jobs,
    ...extra,
  });
  const appFetch = ((u: string, i?: RequestInit) => s.app.request(u, i)) as typeof fetch;
  const pay = createPayingFetch(
    {
      agent: privateKeyToAccount(generatePrivateKey()),
      mandateId: 1n,
      payer: "0.0.1",
      executor: REGISTRY,
      executorEvm: "0x2f30e8F1804Fe163C76918db493a441D44394D5d",
      chainId: 296,
      resolver: new MirrorResolver("https://mirror", (async () =>
        Response.json({ account: identity.hederaAccount, evm_address: identity.evm })) as never),
      maxAmount: 100_000n,
    },
    appFetch,
  );
  const quote = () =>
    s.app.request("http://agent/quote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "trip-1", skill: "flights", input: trip }),
    });
  /** /work, signed by `who` (or unsigned), paid through the x402 client. */
  const hire = async (who: typeof buyer | null = buyer, quoteKey = "0xq1") => {
    const body = JSON.stringify({ task: "trip-1", skill: "flights", input: trip, quoteKey });
    const signed = who ? await signedHeaders(who, "POST", "/work", body) : {};
    return pay("http://agent/work", {
      method: "POST",
      headers: { "content-type": "application/json", ...signed },
      body,
    });
  };
  const read = async (who: typeof buyer | null, quoteKey = "0xq1") =>
    s.app.request(`http://agent/jobs/${quoteKey}`, {
      headers: who ? await signedHeaders(who, "GET", `/jobs/${quoteKey}`, "") : {},
    });
  return { s, quote, hire, read };
}

describe("paid jobs", () => {
  it("a retry from the same buyer gets the same job back: no second payment, no second booking", async () => {
    const a = agent();
    await a.quote();
    const first = await a.hire();
    expect(first.response.status).toBe(200);
    const again = await a.hire();
    expect(again.response.status).toBe(200);
    expect(await again.response.json()).toMatchObject({
      status: "delivered",
      result: { booked: "off_1" },
    });
    expect(again.paid).toBeUndefined(); // answered before any payment
    expect(work).toHaveBeenCalledOnce();
  });

  it("only the buyer that signed /work can read the job", async () => {
    const a = agent();
    await a.quote();
    await a.hire();
    const mine = await a.read(buyer);
    expect(await mine.json()).toMatchObject({
      status: "delivered",
      paymentTx: "0.0.9@1.2",
      payTo: "0.0.5005",
    });
    expect((await a.read(stranger)).status).toBe(404);
    expect((await a.read(null)).status).toBe(401);
    expect((await a.hire(stranger)).response.status).toBe(409); // someone else's quote now
  });

  it("a quote given before a restart is still honoured after it", async () => {
    await agent().quote();
    const restarted = agent(); // same job store, new process
    expect((await restarted.hire()).response.status).toBe(200);
  });

  it("a cancelled payment frees the quote to be paid again", async () => {
    let cancel = true;
    const a = agent({
      settle: async () =>
        cancel
          ? {
              success: false,
              errorReason: "payment_cancelled_in_undo_window",
              transaction: "",
              network: "hedera:testnet" as const,
            }
          : settled,
    });
    await a.quote();
    expect((await a.hire()).response.status).toBe(402);
    expect(jobs.job("0xq1")).toBeNull();
    cancel = false;
    expect((await a.hire()).response.status).toBe(200);
  });
});

describe("when the payment call breaks off", () => {
  const broken = async (): Promise<never> => {
    throw new Error("socket hang up");
  };

  it("asks the chain; paid → does the job, and the buyer reads it later", async () => {
    const paymentState = vi.fn(async () => ({
      state: "paid" as const,
      transaction: "0.0.9@7.7?scheduled",
    }));
    const a = agent({ settle: broken, paymentState });
    await a.quote();
    const res = await a.hire();
    expect(res.response.status).toBe(202);
    expect(await res.response.json()).toMatchObject({ status: "paying" });
    await vi.waitFor(() => expect(jobs.job("0xq1")?.status).toBe("delivered"));
    expect(paymentState).toHaveBeenCalledWith({
      mandateId: 1n,
      nonce: expect.any(BigInt),
      validBefore: expect.any(BigInt),
    });
    expect(await (await a.read(buyer)).json()).toMatchObject({
      status: "delivered",
      paymentTx: "0.0.9@7.7?scheduled",
      result: { booked: "off_1" },
    });
  });

  it("asks the chain; never paid → the quote is free again and nothing is done", async () => {
    const a = agent({ settle: broken, paymentState: async () => ({ state: "unpaid" as const }) });
    await a.quote();
    await a.hire();
    await vi.waitFor(() => expect(jobs.job("0xq1")).toBeNull());
    expect(work).not.toHaveBeenCalled();
  });
});

describe("after a restart", () => {
  it("refunds a job that stopped mid-way and finishes one whose payment went through", async () => {
    const a = agent({ settle: async () => new Promise<never>(() => {}) }); // never answers
    await a.quote();
    jobs.saveQuote("0xq2", "trip-2", { offerId: "off_2" }, Date.now() + 60_000);
    void a.hire(buyer, "0xq1"); // left "paying"
    await vi.waitFor(() => expect(jobs.job("0xq1")?.status).toBe("paying"));
    jobs.claim({
      quoteKey: "0xq2",
      task: "trip-2",
      buyer: null,
      request: {},
      payment: { payer: "0.0.1", mandateId: "1", nonce: "2", validBefore: "9" },
    });
    jobs.update("0xq2", { status: "working" }); // was mid-booking when it died

    const restarted = agent({ paymentState: async () => ({ state: "paid" as const }) });
    expect(restarted.s.recover()).toBe(2);
    await vi.waitFor(() => {
      expect(jobs.job("0xq1")?.status).toBe("delivered");
      expect(jobs.job("0xq2")).toMatchObject({
        status: "failed",
        refund: { transaction: "0.0.5005@9.9" },
      });
    });
  });
});

describe("public delivery record", () => {
  it("the agent writes how a real Arkiv quote's job ended, with a hash, not the result", async () => {
    const real = `0x${"ab".repeat(32)}`;
    vi.mocked(postQuote).mockResolvedValueOnce({ entityKey: real, txHash: "0xt" } as never);
    const a = agent();
    await a.quote();
    await a.hire(buyer, real);
    expect(recordDelivery).toHaveBeenCalledWith(expect.anything(), {
      task: "trip-1",
      agent: identity.evm,
      quote: real,
      status: "delivered",
      resultHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
    });
  });
});
