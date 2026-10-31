import { describe, expect, it } from "vitest";
import { PROJECT } from "./config";
import { decodeEntity, type RawEntity } from "./decode";
import { attributesFor, type Quote, toPayloadJson } from "./records";

const AGENT = "0x1111111111111111111111111111111111111111" as const;
const OTHER = "0x2222222222222222222222222222222222222222" as const;
const KEY = `0x${"ab".repeat(32)}` as const;

const quote: Quote = {
  agent: AGENT,
  task: "goa-weekend-1",
  skill: "flights",
  priceUnits: 50_000n,
  note: "BOM→GOI Fri 7pm",
};

/** Builds an entity the way Arkiv would return it after our write. */
function entity(
  record: object,
  attrs: Record<string, { type: string; value: unknown }>,
  creator: `0x${string}` = AGENT,
): RawEntity {
  return {
    key: KEY,
    creator,
    expiresAt: 1_000n,
    payload: new TextEncoder().encode(JSON.stringify(toPayloadJson(record))),
    attributes: attrs,
  };
}

const quoteAttrs = (over: Record<string, { type: string; value: unknown }> = {}) => ({
  project: { type: "str", value: PROJECT },
  kind: { type: "str", value: "quote" },
  agent: { type: "addr", value: AGENT },
  task: { type: "str", value: "goa-weekend-1" },
  skill: { type: "str", value: "flights" },
  price_units: { type: "u64", value: 50_000n },
  ...over,
});

describe("attributes", () => {
  it("tag every record with our project and kind", () => {
    const a = attributesFor.quote(quote) as Record<string, unknown>;
    expect(a.project).toBeDefined();
    expect(a.kind).toBeDefined();
    expect(Object.keys(a)).toEqual(
      expect.arrayContaining(["agent", "task", "skill", "price_units"]),
    );
  });

  it("stay within Arkiv's 30-attribute limit", () => {
    expect(
      Object.keys(
        attributesFor.receipt({
          job: KEY,
          task: "t",
          mandateId: 1n,
          payer: "0.0.1",
          payTo: "0.0.2",
          amountUnits: 1n,
          hederaTx: "0.0.1@1.2",
          hcsSequence: 3n,
        }),
      ).length,
    ).toBeLessThanOrEqual(30);
  });

  it("serialise bigints in payloads as strings", () => {
    expect(toPayloadJson(quote).priceUnits).toBe("50000");
  });
});

describe("decodeEntity", () => {
  it("decodes a quote written by the agent it names", () => {
    const d = decodeEntity("quote", entity(quote, quoteAttrs()));
    expect(d?.record.priceUnits).toBe(50_000n);
    expect(d?.record.agent).toBe(AGENT);
  });

  it("carries the signed item price in the payload", () => {
    const priced = { ...quote, itemTotal: 5216.4, itemCurrency: "INR" };
    expect(toPayloadJson(priced)).toMatchObject({ itemTotal: 5216.4, itemCurrency: "INR" });
    const d = decodeEntity("quote", entity(priced, quoteAttrs()));
    expect(d?.record).toMatchObject({ itemTotal: 5216.4, itemCurrency: "INR" });
  });

  it("rejects a quote whose author is not the agent it claims to be", () => {
    expect(decodeEntity("quote", entity(quote, quoteAttrs(), OTHER))).toBeNull();
  });

  it("uses indexed attributes over the payload (what the query matched)", () => {
    const d = decodeEntity("quote", entity({ ...quote, priceUnits: 1n }, quoteAttrs()));
    expect(d?.record.priceUnits).toBe(50_000n);
  });

  it("rejects malformed payloads and invalid records", () => {
    const bad = { ...entity(quote, quoteAttrs()), payload: new TextEncoder().encode("not json") };
    expect(decodeEntity("quote", bad)).toBeNull();
    expect(
      decodeEntity(
        "quote",
        entity(
          { ...quote, task: "BAD TASK" },
          quoteAttrs({ task: { type: "str", value: "BAD TASK" } }),
        ),
      ),
    ).toBeNull();
  });

  it("requires ratings to be written by the rater", () => {
    const rating = { agent: OTHER, job: KEY, rater: AGENT, score: 5, comment: "fast" };
    const attrs = {
      agent: { type: "addr", value: OTHER },
      job: { type: "key", value: KEY },
      rater: { type: "addr", value: AGENT },
      score: { type: "i32", value: 5 },
    };
    expect(decodeEntity("rating", entity(rating, attrs, AGENT))?.record.score).toBe(5);
    expect(decodeEntity("rating", entity(rating, attrs, OTHER))).toBeNull();
  });

  it("rejects out-of-range ratings", () => {
    const rating = { agent: OTHER, job: KEY, rater: AGENT, score: 9, comment: "" };
    expect(decodeEntity("rating", entity(rating, { score: { type: "i32", value: 9 } }))).toBeNull();
  });
});

describe("invoices", () => {
  const invoice = {
    agent: AGENT,
    buyer: OTHER,
    task: "trip-goi-1",
    amountUnits: 42_000n,
    note: "PriceGuard: saved ₹2,000 at Park Inn — 20% fee",
    proof: '{"attestation":{},"signature":"0x"}',
  };
  const attrs = {
    project: { type: "str", value: "eth-agentnet-mumbai26" },
    kind: { type: "str", value: "invoice" },
    agent: { type: "addr", value: AGENT },
    buyer: { type: "addr", value: OTHER },
    task: { type: "str", value: "trip-goi-1" },
    amount_units: { type: "u64", value: 42_000n },
  };

  it("indexes who issued it, who owes it, the task and the amount", () => {
    expect(Object.keys(attributesFor.invoice(invoice))).toEqual([
      "project",
      "kind",
      "agent",
      "buyer",
      "task",
      "amount_units",
    ]);
  });

  it("is only trusted from the agent that issued it", () => {
    expect(decodeEntity("invoice", entity(invoice, attrs, AGENT))?.record.amountUnits).toBe(
      42_000n,
    );
    expect(decodeEntity("invoice", entity(invoice, attrs, OTHER))).toBeNull();
  });
});

describe("open tasks and claims", () => {
  const task = {
    task: "chat-1-abc",
    poster: AGENT,
    skill: "flights",
    title: "Flight BOM→BLR, 18 Nov, 1 adult",
    input: { origin: "BOM", destination: "BLR" },
    maxFeeUnits: 100_000n,
    status: "open" as const,
  };
  const attrs = (status = "open") => ({
    project: { type: "str", value: PROJECT },
    kind: { type: "str", value: "task" },
    task: { type: "str", value: "chat-1-abc" },
    poster: { type: "addr", value: AGENT },
    skill: { type: "str", value: "flights" },
    max_fee_units: { type: "u64", value: 100_000n },
    status: { type: "str", value: status },
  });

  it("reads a task, taking its status from the indexed attribute", () => {
    const d = decodeEntity("task", entity(task, attrs("awarded")));
    expect(d?.record).toMatchObject({ skill: "flights", maxFeeUnits: 100_000n, status: "awarded" });
    expect(Object.keys(attributesFor.task(task))).toEqual(
      expect.arrayContaining(["task", "poster", "skill", "max_fee_units", "status"]),
    );
  });

  it("drops a task or claim that someone other than its poster wrote", () => {
    expect(decodeEntity("task", entity(task, attrs(), OTHER))).toBeNull();
    const claim = { task: "chat-1-abc", poster: AGENT, quote: KEY, agent: OTHER };
    // attributesFor already carries project and kind
    const claimAttrs = attributesFor.claim(claim) as unknown as Record<
      string,
      { type: string; value: unknown }
    >;
    expect(decodeEntity("claim", entity(claim, claimAttrs))?.record.agent).toBe(OTHER);
    expect(decodeEntity("claim", entity(claim, claimAttrs, OTHER))).toBeNull();
  });

  it("refuses a task whose public input is too large", () => {
    const big = { ...task, input: { notes: "x".repeat(5000) } };
    expect(decodeEntity("task", entity(big, attrs()))).toBeNull();
  });
});
