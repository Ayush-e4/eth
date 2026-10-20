import { describe, expect, it } from "vitest";
import { HealthSchema, health } from "./index";

describe("health", () => {
  it("returns a payload that matches the schema", () => {
    expect(HealthSchema.parse(health("api")).service).toBe("api");
  });
});
