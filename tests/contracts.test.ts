import { describe, expect, it } from "vitest";
import { checkContract } from "../scripts/check-contract.js";

describe("web safety and transport contract", () => {
  it("accepts the OpenAPI contract and every applicable conformance fixture", () => {
    expect(checkContract().fixtureCount).toBe(8);
  });
});
