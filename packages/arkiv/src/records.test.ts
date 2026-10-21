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
