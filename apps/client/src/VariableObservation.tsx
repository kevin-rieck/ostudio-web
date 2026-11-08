import type { AddressSpaceNode, Snapshot } from "@ostudio/contracts";

export interface VariableObservationProps {
  snapshot: Snapshot;
  selectedNodeId?: string;
  selectedNode?: AddressSpaceNode;
  resynchronizing: boolean;
  controllerRole: "controller" | "observer";
  working: boolean;
  onSelect(nodeId: string): void;
  onAddToWatchlist(nodeId: string): void;
  onRemoveFromWatchlist(nodeId: string): void;
}

export function VariableObservation({
  snapshot,
  selectedNodeId,
  selectedNode,
  resynchronizing,
  controllerRole,
  working,
  onSelect,
  onAddToWatchlist,
  onRemoveFromWatchlist,
}: VariableObservationProps) {
  const selectedInspection = selectedNodeId ? snapshot.inspections[selectedNodeId] : undefined;
  const selectedLiveValue = selectedInspection?.liveValue ?? selectedNode?.liveValue;
  const selectedTrend = selectedNodeId ? (snapshot.trends[selectedNodeId] ?? []) : [];
  const selectedIsWatched = selectedNodeId ? snapshot.watchlist.includes(selectedNodeId) : false;

  return (
    <>
      {selectedNodeId && (
        <section aria-labelledby="inspection-heading">
          <h3 id="inspection-heading">Variable Node Inspection</h3>
          <p>{selectedInspection?.metadata?.displayName?.text ?? selectedNode?.displayName ?? selectedNodeId}</p>
          <dl>
            <dt>Node identifier</dt>
            <dd>{selectedNodeId}</dd>
            <dt>Data type</dt>
            <dd>{selectedInspection?.metadata?.dataType ?? "Unavailable"}</dd>
            <dt>Value rank</dt>
            <dd>{selectedInspection?.metadata?.valueRank ?? "Unavailable"}</dd>
            <dt>Array dimensions</dt>
            <dd>{selectedInspection?.metadata?.arrayDimensions?.join(" × ") ?? "Unavailable"}</dd>
            <dt>Live Value</dt>
            <dd>{selectedLiveValue?.displayValue ?? "No Live Value"}</dd>
            <dt>Status</dt>
            <dd>{selectedLiveValue?.status ?? "Unavailable"}</dd>
            <dt>Source timestamp</dt>
            <dd>{selectedLiveValue?.sourceTimestamp ?? "Not provided"}</dd>
            <dt>Server timestamp</dt>
            <dd>{selectedLiveValue?.serverTimestamp ?? "Not provided"}</dd>
            <dt>Value freshness</dt>
            <dd>{resynchronizing || selectedLiveValue?.stale ? "Stale Value" : "Current"}</dd>
            <dt>Out-of-range state</dt>
            <dd>
              {selectedInspection?.metadata?.range
                ? selectedLiveValue?.outOfRange
                  ? "Out of range"
                  : "Within range"
                : "Not reported (no engineering range metadata)"}
            </dd>
          </dl>
          {controllerRole === "controller" && selectedInspection && !selectedIsWatched && (
            <button
              type="button"
              onClick={() => onAddToWatchlist(selectedNodeId)}
              disabled={working || snapshot.connection.state !== "connected"}
            >
              Add to Watchlist
            </button>
          )}
          <h4>Session Trend</h4>
          {selectedTrend.length ? (
            <ol aria-label="Session Trend">
              {selectedTrend.map((point, index) => (
                <li key={`${point.timestamp}-${index}`}>
                  {point.timestamp} · {point.displayValue} · {point.status}
                </li>
              ))}
            </ol>
          ) : (
            <p>No Session Trend points yet.</p>
          )}
        </section>
      )}
      <section aria-labelledby="watchlist-heading">
        <h3 id="watchlist-heading">Watchlist</h3>
        {snapshot.watchlist.length ? (
          <ul>
            {snapshot.watchlist.map((nodeId) => {
              const node = snapshot.nodes.find((item) => item.nodeId === nodeId);
              const liveValue = snapshot.inspections[nodeId]?.liveValue ?? node?.liveValue;
              return (
                <li key={nodeId}>
                  <button type="button" onClick={() => onSelect(nodeId)}>
                    {node?.displayName ?? nodeId}: {liveValue?.displayValue ?? "No Live Value"}
                    {resynchronizing || liveValue?.stale ? " · Stale Value" : ""}
                  </button>
                  {controllerRole === "controller" && (
                    <button type="button" onClick={() => onRemoveFromWatchlist(nodeId)} disabled={working}>
                      Remove
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p>No Variable Nodes are in the Watchlist.</p>
        )}
      </section>
    </>
  );
}
