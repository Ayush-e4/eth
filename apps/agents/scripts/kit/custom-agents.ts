// The agents you made with the agent kit: their identities live in a gitignored file (mode 600).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Hex } from "viem";
import { dataFile } from "../../src/data-dir";

export interface CustomAgent {
  key: Hex; // signs its Arkiv records and owns its identity; never share it
  evm: `0x${string}`;
  hederaAccount: string; // where it gets paid
  port: number;
}

export const CUSTOM_PATH = dataFile(".custom-agents.local.json");
export const sourceOf = (slug: string) =>
  fileURLToPath(new URL(`../../src/custom/${slug}.ts`, import.meta.url));

export const loadCustom = (): Record<string, CustomAgent> =>
  existsSync(CUSTOM_PATH) ? JSON.parse(readFileSync(CUSTOM_PATH, "utf8")) : {};

export const saveCustom = (all: Record<string, CustomAgent>) =>
  writeFileSync(CUSTOM_PATH, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
