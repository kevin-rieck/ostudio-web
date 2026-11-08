import { describe, expect, it } from "vitest";
import { savedSecretForTarget, type SavedConnectionSecret } from "./saved-connection-secret.js";

describe("Saved Connection secret binding", () => {
  it("does not return a secret for a different reconnect target", () => {
    const secret: SavedConnectionSecret = { targetId: "connection-a", value: "a-secret" };

    expect(savedSecretForTarget(secret, "connection-a")).toBe("a-secret");
    expect(savedSecretForTarget(secret, "connection-b")).toBeUndefined();
  });
});
