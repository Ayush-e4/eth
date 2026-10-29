import type { Client } from "@hiero-ledger/sdk";
import { describe, expect, it, vi } from "vitest";
import { spendLog } from "./spend-log";

const client = {} as Client;
const hired = {
  kind: "agentnet.hired",
  mandateId: "7",
  skill: "flights",
  agent: "0xabc",
  fee: "30000",
  payment: "0.0.1@1.2",
  job: "0xjob",
} as const;

describe("spendLog", () => {
  it("appends the event with a timestamp and returns its sequence number", async () => {
    const submit = vi.fn(async () => ({ sequence: 42, transactionId: "0.0.1@3.4" }));
    const log = spendLog(client, "0.0.99", "key", submit);
    expect(await log.write(hired)).toBe(42);
    expect(submit).toHaveBeenCalledWith(client, {
      topicId: "0.0.99",
      submitKey: "key",
      message: { ...hired, at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) },
    });
  });

  it("never throws: a failed write returns null", async () => {
    const submit = vi.fn(async () => {
      throw new Error("BUSY");
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await spendLog(client, "0.0.99", "key", submit).write(hired)).toBeNull();
    err.mockRestore();
  });
});
