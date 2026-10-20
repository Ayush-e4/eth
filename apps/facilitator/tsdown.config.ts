import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  platform: "node",
  // Bundle our workspace packages (they ship TS source); keep npm deps external.
  noExternal: [/^@eth\//],
});
