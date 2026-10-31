import { defineConfig } from "vitest/config";

// The first test in each worker migrates the template database (see src/test/db.ts); when every
// package tests at once that can take several seconds, so allow for it.
export default defineConfig({
  test: { testTimeout: 20_000, hookTimeout: 30_000 },
});
