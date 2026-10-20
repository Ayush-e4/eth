import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Abi, toEventSelector, toFunctionSelector } from "viem";
import { describe, expect, it } from "vitest";
import { mandateRegistryAbi } from "./abi";

// Built by `forge build` (turbo builds @eth/contracts before testing this package).
const artifactPath = fileURLToPath(
  new URL("../../contracts/out/MandateRegistry.sol/MandateRegistry.json", import.meta.url),
);
const compiled = JSON.parse(readFileSync(artifactPath, "utf8")).abi as Abi;

function signatures(abi: Abi, type: "function" | "event" | "error") {
  return abi
    .filter((item) => item.type === type)
    .map((item) =>
      type === "event" ? toEventSelector(item as never) : toFunctionSelector(item as never),
    )
    .sort();
}

describe("mandateRegistryAbi matches the compiled contract", () => {
  it("functions we use exist with identical signatures", () => {
    const compiledFns = new Set(signatures(compiled, "function"));
    for (const sel of signatures(mandateRegistryAbi, "function")) {
      expect(compiledFns.has(sel), `function selector ${sel}`).toBe(true);
    }
  });

  it("events are identical", () => {
    expect(signatures(mandateRegistryAbi, "event")).toEqual(signatures(compiled, "event"));
  });

  it("errors are identical (including OpenZeppelin ones we surface)", () => {
    const ours = new Set(signatures(mandateRegistryAbi, "error"));
    const contractErrors = compiled
      .filter((i) => i.type === "error")
      .filter(
        (i) =>
          !("name" in i) ||
          !/^(ECDSA|SafeERC20|InvalidShortString|StringTooLong|AddressEmptyCode|FailedCall)/.test(
            i.name,
          ),
      )
      .map((i) => toFunctionSelector(i as never));
    for (const sel of contractErrors) expect(ours.has(sel), `error ${sel}`).toBe(true);
  });

  it("executeTransfer has the x402 spec selector", () => {
    expect(toFunctionSelector("executeTransfer(address,address,address,uint256,bytes)")).toBe(
      "0xea8f19fd",
    );
  });
});
