import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Snapshot } from "@ostudio/contracts";
import { VariableObservation } from "./VariableObservation.js";

const nodeId = "ns=1;s=Temperature";
const snapshot: Snapshot = {
  sequence: 1,
  buildVersion: "test",
  generatedAt: "2026-01-01T00:00:00Z",
  controller: { role: "observer", controllerGeneration: 1 },
  safety: { readOnly: true, safetyGeneration: 1 },
  connection: { state: "connected" },
  nodes: [{ nodeId, nodeClass: "Variable", browseName: "Temperature", displayName: "Temperature" }],
  watchlist: [nodeId],
  inspections: {
    [nodeId]: {
      nodeId,
      stale: false,
      outOfRange: true,
      metadata: { nodeId, dataType: "Double", valueRank: -1, range: { low: 20, high: 30 } },
      liveValue: { displayValue: "42", status: "Good", stale: false, outOfRange: true },
    },
  },
  trends: { [nodeId]: [{ timestamp: "2026-01-01T00:00:00Z", displayValue: "42", status: "Good" }] },
};

function render(resynchronizing: boolean, controllerRole: "observer" | "controller" = "observer") {
  return renderToStaticMarkup(
    <VariableObservation
      snapshot={snapshot}
      selectedNodeId={nodeId}
      selectedNode={snapshot.nodes[0]}
      resynchronizing={resynchronizing}
      controllerRole={controllerRole}
      working={false}
      onSelect={() => undefined}
      onAddToWatchlist={() => undefined}
      onRemoveFromWatchlist={() => undefined}
    />,
  );
}

describe("VariableObservation", () => {
  it("shows metadata, out-of-range Live Value and Session Trend without observer mutation controls", () => {
    const html = render(false);
    expect(html).toContain("Out of range");
    expect(html).toContain("Session Trend");
    expect(html).toContain("Temperature: 42");
    expect(html).toContain("Current");
    expect(html).not.toContain("Stale Value");
    expect(html).not.toContain("Remove");
  });

  it("marks the inspection and Watchlist stale while resynchronizing", () => {
    const html = render(true, "controller");
    expect(html).toContain("Temperature: 42 · Stale Value");
    expect(html).toContain("Remove");
  });
});
