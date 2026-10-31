import { describe, expect, it, vi } from "vitest";
import { ownEntries } from "./read";
import { renewOwn } from "./renew";

vi.mock("./read", () => ({ ownEntries: vi.fn() }));

const DAY = 86_400;

describe("renewOwn", () => {
  it("extends only the agent's own entries that are close to running out", async () => {
    vi.mocked(ownEntries).mockResolvedValue([
      { kind: "agent", key: "0xa1", secondsLeft: 3 * DAY },
      { kind: "listing", key: "0xb1", secondsLeft: 9 * DAY },
      { kind: "listing", key: "0xb2", secondsLeft: 25 * DAY },
    ]);
    const extendEntity = vi.fn(async () => ({}));
    const w = { account: { address: "0x00000000000000000000000000000000000000a9" }, extendEntity };
    const renewed = await renewOwn(w as never, {} as never);
    expect(ownEntries).toHaveBeenCalledWith({}, "0x00000000000000000000000000000000000000a9");
    expect(renewed.map((r) => r.key)).toEqual(["0xa1", "0xb1"]);
    expect(extendEntity).toHaveBeenCalledTimes(2);
    expect(extendEntity).toHaveBeenCalledWith(expect.objectContaining({ entityKey: "0xa1" }));
  });

  it("does nothing when everything has plenty of time left", async () => {
    vi.mocked(ownEntries).mockResolvedValue([
      { kind: "agent", key: "0xa1", secondsLeft: 20 * DAY },
    ]);
    const extendEntity = vi.fn();
    const w = { account: { address: "0x00000000000000000000000000000000000000a9" }, extendEntity };
    expect(await renewOwn(w as never, {} as never)).toEqual([]);
    expect(extendEntity).not.toHaveBeenCalled();
  });
});
