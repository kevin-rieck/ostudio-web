import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ApiClientError,
  createApiClient,
  type DiagnosticReport,
  type EndpointDiscoveryResult,
  type Snapshot,
} from "@ostudio/contracts";

const api = createApiClient();

function failureMessage(error: unknown, fallback: string): string {
  return error instanceof ApiClientError ? error.message : fallback;
}

export function App() {
  const [authenticated, setAuthenticated] = useState(false);
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string>();
  const [insecureDevelopment, setInsecureDevelopment] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [resynchronizing, setResynchronizing] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
  const controllerRole = snapshot?.controller.role ?? "observer";
  const [endpointUrl, setEndpointUrl] = useState("");
  const [discovery, setDiscovery] = useState<EndpointDiscoveryResult>();
  const [diagnostics, setDiagnostics] = useState<DiagnosticReport>([]);
  const [browseNodeId, setBrowseNodeId] = useState("i=84");
  const [searchQuery, setSearchQuery] = useState("");
  const [working, setWorking] = useState(false);
  const controllerControls = useRef<{ setGeneration(generation: number): void; startRenewal(): void } | undefined>(
    undefined,
  );

  useEffect(() => {
    void api
      .getAuthenticationSession()
      .then((session) => {
        setAuthenticated(session.authenticated);
        setInsecureDevelopment(session.insecureDevelopment);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!authenticated) {
      setSnapshot(undefined);
      setResynchronizing(false);
      setSelectedNodeId(undefined);
      return;
    }
    let stopped = false;
    let connecting = false;
    let source: EventSource | undefined;
    let renewTimer: number | undefined;
    let retryTimer: number | undefined;
    let controllerGeneration: number | undefined;
    const stopRenewal = (): void => {
      if (renewTimer !== undefined) window.clearInterval(renewTimer);
      renewTimer = undefined;
    };
    const markValuesStale = (): void => {
      setResynchronizing(true);
    };
    const startRenewal = (): void => {
      if (controllerGeneration === undefined || renewTimer !== undefined) return;
      renewTimer = window.setInterval(() => {
        void api.renewControllerLease(controllerGeneration!).catch(() => {
          stopRenewal();
          markValuesStale();
          void refreshSnapshot().catch(() => undefined);
        });
      }, 5_000);
    };
    const refreshSnapshot = async (): Promise<Snapshot> => {
      const [current, report] = await Promise.all([api.getSnapshot(), api.getDiagnosticReport()]);
      if (!stopped) {
        setDiagnostics(report);
        setSnapshot(current);
        setResynchronizing(false);
        controllerGeneration = current.controller.controllerGeneration;
        if (current.controller.role === "controller") startRenewal();
        else stopRenewal();
      }
      return current;
    };
    const retry = (): void => {
      if (!stopped && retryTimer === undefined)
        retryTimer = window.setTimeout(() => {
          retryTimer = undefined;
          void connectEvents();
        }, 1_000);
    };
    const connectEvents = async (): Promise<void> => {
      if (stopped || connecting) return;
      connecting = true;
      try {
        const current = await refreshSnapshot();
        if (stopped) return;
        source?.close();
        const eventSource = new EventSource(`/api/v1/events?afterSequence=${current.sequence}`);
        source = eventSource;
        eventSource.onmessage = () => {
          markValuesStale();
          void refreshSnapshot().catch(retry);
        };
        eventSource.onerror = () => {
          eventSource.close();
          if (source === eventSource) source = undefined;
          markValuesStale();
          retry();
        };
      } catch {
        retry();
      } finally {
        connecting = false;
      }
    };
    const onOffline = (): void => {
      markValuesStale();
      source?.close();
      source = undefined;
      retry();
    };
    const onOnline = (): void => {
      markValuesStale();
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      retryTimer = undefined;
      void connectEvents();
    };
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    controllerControls.current = {
      setGeneration: (generation) => {
        controllerGeneration = generation;
      },
      startRenewal,
    };
    void api
      .attachController()
      .then((controller) => {
        if (stopped) return;
        controllerGeneration = controller.controllerGeneration;
        if (controller.role === "controller") startRenewal();
        void connectEvents();
      })
      .catch(() => {
        void connectEvents();
      });
    return () => {
      stopped = true;
      source?.close();
      stopRenewal();
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      controllerControls.current = undefined;
    };
  }, [authenticated]);

  async function login(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setMessage(undefined);
    try {
      await api.loginAdmin({ username, password });
      const session = await api.getAuthenticationSession();
      setAuthenticated(session.authenticated);
      setInsecureDevelopment(session.insecureDevelopment);
      setPassword("");
    } catch (error) {
      setMessage(failureMessage(error, "Sign-in failed."));
    }
  }

  async function withWorking(action: () => Promise<void>, fallback: string): Promise<void> {
    setMessage(undefined);
    setWorking(true);
    try {
      await action();
    } catch (error) {
      setMessage(failureMessage(error, fallback));
    } finally {
      setWorking(false);
    }
  }

  async function discoverEndpoints(): Promise<void> {
    await withWorking(async () => {
      const result = await api.discoverOpcUaEndpoints({ endpointUrl }, snapshot!.controller.controllerGeneration);
      setDiscovery(result);
    }, "Endpoint discovery failed.");
  }

  async function connect(): Promise<void> {
    const selected = discovery?.endpoints.find(
      (endpoint) => endpoint.endpointUrl === endpointUrl && endpoint.securityMode === "None",
    );
    if (!selected) {
      setMessage("Select a discovered SecurityPolicy None endpoint first.");
      return;
    }
    await withWorking(async () => {
      const current = await api.connectOpcUa(
        { endpointUrl: selected.endpointUrl },
        snapshot!.controller.controllerGeneration,
      );
      setSnapshot(current);
      setResynchronizing(false);
    }, "The OPC UA Server connection failed.");
  }

  async function disconnect(): Promise<void> {
    await withWorking(async () => {
      const current = await api.disconnectOpcUa(snapshot!.controller.controllerGeneration);
      setSnapshot(current);
      setResynchronizing(false);
      setSelectedNodeId(undefined);
      setDiscovery(undefined);
    }, "The OPC UA Server could not be disconnected.");
  }

  async function browse(): Promise<void> {
    await withWorking(async () => {
      await api.browseAddressSpace({ nodeId: browseNodeId }, snapshot!.controller.controllerGeneration);
      setSnapshot(await api.getSnapshot());
    }, "Address Space browsing failed.");
  }

  async function search(): Promise<void> {
    await withWorking(async () => {
      await api.searchAddressSpace({ query: searchQuery }, snapshot!.controller.controllerGeneration);
      setSnapshot(await api.getSnapshot());
      setResynchronizing(false);
    }, "Address Space Search failed.");
  }

  async function inspectVariable(nodeId: string): Promise<void> {
    setSelectedNodeId(nodeId);
    if (controllerRole !== "controller" || !snapshot) return;
    await withWorking(async () => {
      setSnapshot(await api.inspectVariable({ nodeId }, snapshot.controller.controllerGeneration));
      setResynchronizing(false);
    }, "Variable Node Inspection failed.");
  }

  async function addToWatchlist(nodeId: string): Promise<void> {
    if (!snapshot) return;
    await withWorking(async () => {
      setSnapshot(await api.addToWatchlist({ nodeId }, snapshot.controller.controllerGeneration));
      setResynchronizing(false);
    }, "The Variable Node could not be added to the Watchlist.");
  }

  async function removeFromWatchlist(nodeId: string): Promise<void> {
    if (!snapshot) return;
    await withWorking(async () => {
      setSnapshot(await api.removeFromWatchlist({ nodeId }, snapshot.controller.controllerGeneration));
      setResynchronizing(false);
    }, "The Variable Node could not be removed from the Watchlist.");
  }

  async function recoverControl(): Promise<void> {
    await withWorking(async () => {
      const controller = await api.recoverController();
      controllerControls.current?.setGeneration(controller.controllerGeneration);
      setSnapshot((current) => current && { ...current, controller });
      controllerControls.current?.startRenewal();
    }, "Control recovery failed.");
  }

  async function takeOver(): Promise<void> {
    await withWorking(async () => {
      const controller = await api.takeOverController();
      controllerControls.current?.setGeneration(controller.controllerGeneration);
      setSnapshot((current) => current && { ...current, controller });
      controllerControls.current?.startRenewal();
    }, "Control transfer failed.");
  }

  async function logout(): Promise<void> {
    await withWorking(async () => {
      await api.logoutAdmin();
      setAuthenticated(false);
      setPassword("");
    }, "Sign-out failed.");
  }

  const selectedNode = snapshot?.nodes.find((node) => node.nodeId === selectedNodeId);
  const selectedInspection = selectedNodeId ? snapshot?.inspections[selectedNodeId] : undefined;
  const selectedLiveValue = selectedInspection?.liveValue ?? selectedNode?.liveValue;
  const selectedTrend = selectedNodeId ? (snapshot?.trends[selectedNodeId] ?? []) : [];
  const selectedIsWatched = selectedNodeId ? (snapshot?.watchlist.includes(selectedNodeId) ?? false) : false;

  return (
    <main className="shell">
      <p className="eyebrow">OPC UA Studio</p>
      <h1>Web workspace ready</h1>
      {insecureDevelopment && (
        <p className="warning" role="status">
          Insecure development mode is enabled. Do not expose this server publicly.
        </p>
      )}
      {authenticated ? (
        <>
          <h2>Troubleshooting Session</h2>
          <p role="status">
            {snapshot?.connection.state ?? "disconnected"} ·{" "}
            {controllerRole === "controller" ? "Controller" : "Observer"} · Read-Only Mode
          </p>
          {resynchronizing && (
            <p className="warning" role="status">
              Live Values are stale while OPC UA Studio resynchronizes from an authoritative snapshot.
            </p>
          )}
          {controllerRole === "observer" &&
            (snapshot?.controller.recoverable ? (
              <button type="button" onClick={() => void recoverControl()} disabled={working}>
                Recover control
              </button>
            ) : (
              <button type="button" onClick={() => void takeOver()} disabled={working}>
                Take over control
              </button>
            ))}
          {snapshot?.connection.state === "connected" && snapshot.connection.identityStatus === "unverified" && (
            <p className="warning" role="alert">
              SecurityPolicy None: OPC UA Server identity is unverified.
            </p>
          )}
          {controllerRole === "controller" && (
            <section aria-labelledby="connection-heading">
              <h3 id="connection-heading">OPC UA Server connection</h3>
              <label>
                Endpoint URL
                <input
                  value={endpointUrl}
                  onChange={(event) => setEndpointUrl(event.target.value)}
                  placeholder="opc.tcp://localhost:4840"
                />
              </label>
              <div className="actions">
                <button type="button" onClick={() => void discoverEndpoints()} disabled={working || !endpointUrl}>
                  Discover endpoints
                </button>
                <button type="button" onClick={() => void connect()} disabled={working || !discovery}>
                  Connect anonymously
                </button>
                <button
                  type="button"
                  onClick={() => void disconnect()}
                  disabled={working || snapshot?.connection.state !== "connected"}
                >
                  Disconnect
                </button>
              </div>
              {discovery && (
                <ul>
                  {discovery.endpoints.map((endpoint) => (
                    <li key={`${endpoint.endpointUrl}-${endpoint.securityMode}-${endpoint.securityPolicyUri}`}>
                      <button type="button" onClick={() => setEndpointUrl(endpoint.endpointUrl)}>
                        {endpoint.securityMode} · {endpoint.securityPolicyUri}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
          {controllerRole === "observer" && snapshot?.nodes.length ? (
            <section aria-label="Address Space">
              <ul>
                {snapshot.nodes.map((node) => (
                  <li key={node.nodeId}>
                    {node.nodeClass === "Variable" ? (
                      <button type="button" onClick={() => void inspectVariable(node.nodeId)}>
                        {node.displayName}
                      </button>
                    ) : (
                      node.displayName
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {controllerRole === "controller" && snapshot?.connection.state === "connected" && (
            <section aria-labelledby="address-space-heading">
              <h3 id="address-space-heading">Address Space</h3>
              <div className="actions">
                <input
                  value={browseNodeId}
                  onChange={(event) => setBrowseNodeId(event.target.value)}
                  aria-label="Node identifier"
                />
                <button type="button" onClick={() => void browse()} disabled={working}>
                  Browse
                </button>
              </div>
              {snapshot.browsed && (
                <ul>
                  {snapshot.browsed.references.map((reference) => (
                    <li key={reference.nodeId}>
                      <button
                        type="button"
                        onClick={() =>
                          reference.nodeClass === "Variable"
                            ? void inspectVariable(reference.nodeId)
                            : setBrowseNodeId(reference.nodeId)
                        }
                      >
                        {reference.displayName.text ?? reference.browseName.name ?? reference.nodeId}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="actions">
                <input
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  aria-label="Address Space Search"
                />
                <button type="button" onClick={() => void search()} disabled={working}>
                  Search
                </button>
              </div>
              {snapshot.search && (
                <>
                  <p role="status">
                    {snapshot.search.results.length} result(s); coverage {snapshot.search.coverage}.
                  </p>
                  <ul aria-label="Search matches">
                    {snapshot.search.results.map((match) => (
                      <li key={match.nodeId}>
                        <button
                          type="button"
                          onClick={() =>
                            match.nodeClass === "Variable"
                              ? void inspectVariable(match.nodeId)
                              : setBrowseNodeId(match.nodeId)
                          }
                        >
                          {match.displayName ?? match.browseName ?? match.nodeId}
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          )}
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
                  onClick={() => void addToWatchlist(selectedNodeId)}
                  disabled={working || snapshot?.connection.state !== "connected"}
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
          {snapshot && (
            <section aria-labelledby="watchlist-heading">
              <h3 id="watchlist-heading">Watchlist</h3>
              {snapshot.watchlist.length ? (
                <ul>
                  {snapshot.watchlist.map((nodeId) => {
                    const node = snapshot.nodes.find((item) => item.nodeId === nodeId);
                    const liveValue = snapshot.inspections[nodeId]?.liveValue ?? node?.liveValue;
                    return (
                      <li key={nodeId}>
                        <button type="button" onClick={() => setSelectedNodeId(nodeId)}>
                          {node?.displayName ?? nodeId}: {liveValue?.displayValue ?? "No Live Value"}
                          {resynchronizing || liveValue?.stale ? " · Stale Value" : ""}
                        </button>
                        {controllerRole === "controller" && (
                          <button type="button" onClick={() => void removeFromWatchlist(nodeId)} disabled={working}>
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
          )}
          {diagnostics.length > 0 && (
            <section aria-label="Diagnostics">
              <ul>
                {diagnostics.map((record, index) => (
                  <li key={index}>
                    {"code" in record ? record.code : record.outcome} · {record.endpoint ?? "OPC UA Server"}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <button type="button" onClick={() => void logout()} disabled={working}>
            Sign out
          </button>
        </>
      ) : (
        <>
          <h2>Sign in</h2>
          <form onSubmit={login}>
            <label>
              Username
              <input
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="username"
                required
              />
            </label>
            <label>
              Admin password
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                required
              />
            </label>
            <button type="submit">Sign in</button>
          </form>
        </>
      )}
      {message && (
        <p className="error" role="alert">
          {message}
        </p>
      )}
    </main>
  );
}
