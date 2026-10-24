import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ApiClientError,
  createApiClient,
  type DiagnosticReport,
  type EndpointDiscoveryResult,
  type SavedConnection,
  type Snapshot,
} from "@ostudio/contracts";
import { savedSecretForTarget, type SavedConnectionSecret } from "./saved-connection-secret.js";

const api = createApiClient();

function emptySavedConnection(): SavedConnection {
  return {
    id: "",
    name: "",
    endpoint: "",
    securityPolicy: "None",
    securityMode: "None",
  };
}

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
  const controllerRole = snapshot?.controller.role ?? "observer";
  const [discovery, setDiscovery] = useState<EndpointDiscoveryResult>();
  const [savedConnections, setSavedConnections] = useState<SavedConnection[]>([]);
  const [storageMode, setStorageMode] = useState<"durable" | "ephemeral">("durable");
  const [savedDraft, setSavedDraft] = useState<SavedConnection>(emptySavedConnection);

  const [savedSecret, setSavedSecret] = useState<SavedConnectionSecret>();
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
    const startRenewal = (): void => {
      stopRenewal();
      if (controllerGeneration === undefined) return;
      renewTimer = window.setInterval(() => {
        void api.renewControllerLease(controllerGeneration!).catch(() => {
          stopRenewal();
          setSnapshot(undefined);
          void refreshSnapshot().catch(() => undefined);
        });
      }, 5_000);
    };
    const refreshSnapshot = async (): Promise<Snapshot> => {
      const [current, report, saved] = await Promise.all([
        api.getSnapshot(),
        api.getDiagnosticReport(),
        api.listSavedConnections(),
      ]);
      if (!stopped) {
        setDiagnostics(report);
        setSavedConnections(saved.savedConnections);
        setStorageMode(saved.mode);
        setSnapshot(current);
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
        eventSource.onmessage = () => void refreshSnapshot().catch(retry);
        eventSource.onerror = () => {
          eventSource.close();
          if (source === eventSource) source = undefined;
          retry();
        };
      } catch {
        retry();
      } finally {
        connecting = false;
      }
    };
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
      const result = await api.discoverOpcUaEndpoints(
        { endpointUrl: savedDraft.endpoint },
        snapshot!.controller.controllerGeneration,
      );
      setDiscovery(result);
    }, "Endpoint discovery failed.");
  }

  async function connect(): Promise<void> {
    const selected = discovery?.endpoints.find(
      (endpoint) => endpoint.endpointUrl === savedDraft.endpoint && endpoint.securityMode === "None",
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
    }, "The OPC UA Server connection failed.");
  }

  function editSaved(connection: SavedConnection): void {
    setSavedDraft({ ...connection });
    setSavedSecret(undefined);
  }

  function newSaved(): void {
    setSavedDraft(emptySavedConnection());
    setSavedSecret(undefined);
  }

  async function saveSaved(): Promise<void> {
    await withWorking(async () => {
      const id = savedDraft.id || crypto.randomUUID();
      await api.saveSavedConnection(
        id,
        {
          name: savedDraft.name,
          endpoint: savedDraft.endpoint,
          securityPolicy: savedDraft.securityPolicy,
          securityMode: savedDraft.securityMode,
          ...(savedDraft.username ? { username: savedDraft.username } : {}),
          ...(savedDraft.serverCertificatePin ? { serverCertificatePin: savedDraft.serverCertificatePin } : {}),
          ...(savedDraft.certificateReviewRequired ? { certificateReviewRequired: true } : {}),
        },
        snapshot!.controller.controllerGeneration,
      );
      setSavedSecret(undefined);
      const saved = await api.listSavedConnections();
      setSavedConnections(saved.savedConnections);
      setStorageMode(saved.mode);
      setSavedDraft((current) => ({ ...current, id }));
    }, "The Saved Connection could not be saved.");
  }

  async function deleteSaved(id: string): Promise<void> {
    if (!window.confirm("Delete this Saved Connection?")) return;
    await withWorking(async () => {
      await api.deleteSavedConnection(id, snapshot!.controller.controllerGeneration);
      setSavedConnections((current) => current.filter((connection) => connection.id !== id));
      if (savedDraft.id === id) newSaved();
    }, "The Saved Connection could not be deleted.");
  }

  async function connectSaved(connection: SavedConnection): Promise<void> {
    const userSecret = savedSecretForTarget(savedSecret, connection.id);
    if (savedSecret?.targetId !== connection.id) setSavedSecret(undefined);
    await withWorking(async () => {
      const current = await api.connectSavedConnection(
        connection.id,
        userSecret ? { userSecret } : {},
        snapshot!.controller.controllerGeneration,
      );
      setSnapshot(current);
      setSavedSecret(undefined);
    }, "The Saved Connection could not be connected.");
  }

  async function disconnect(): Promise<void> {
    await withWorking(async () => {
      const current = await api.disconnectOpcUa(snapshot!.controller.controllerGeneration);
      setSnapshot(current);
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
    }, "Address Space Search failed.");
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
          {storageMode === "ephemeral" && (
            <p className="warning" role="alert">
              Ephemeral mode is enabled. Saved Connections will be lost when the server stops.
            </p>
          )}
          {controllerRole === "controller" && (
            <section aria-labelledby="saved-connections-heading">
              <h3 id="saved-connections-heading">Saved Connections</h3>
              {savedDraft.certificateReviewRequired && (
                <p className="warning" role="alert">
                  This Saved Connection contains legacy certificate details and requires review before secure reconnect.
                </p>
              )}
              {savedConnections.length > 0 && (
                <ul aria-label="Saved Connections">
                  {savedConnections.map((connection) => (
                    <li key={connection.id}>
                      <span>
                        {connection.name} · {connection.endpoint}
                        {connection.certificateReviewRequired && (
                          <strong role="status"> · Certificate review required</strong>
                        )}
                      </span>{" "}
                      <button
                        type="button"
                        onClick={() => void connectSaved(connection)}
                        disabled={working || connection.certificateReviewRequired === true}
                      >
                        Reconnect
                      </button>{" "}
                      <button type="button" onClick={() => editSaved(connection)} disabled={working}>
                        Edit
                      </button>{" "}
                      <button type="button" onClick={() => void deleteSaved(connection.id)} disabled={working}>
                        Delete
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <label>
                Saved Connection name
                <input
                  value={savedDraft.name}
                  onChange={(event) => setSavedDraft((current) => ({ ...current, name: event.target.value }))}
                />
              </label>
              <label>
                Security policy
                <input
                  value={savedDraft.securityPolicy}
                  onChange={(event) => setSavedDraft((current) => ({ ...current, securityPolicy: event.target.value }))}
                />
              </label>
              <label>
                Security mode
                <select
                  value={savedDraft.securityMode}
                  onChange={(event) =>
                    setSavedDraft((current) => ({
                      ...current,
                      securityMode: event.target.value as SavedConnection["securityMode"],
                    }))
                  }
                >
                  <option value="None">None</option>
                  <option value="Sign">Sign</option>
                  <option value="SignAndEncrypt">Sign and Encrypt</option>
                </select>
              </label>
              <label>
                Server certificate SHA-256 pin (required for secure connections)
                <input
                  value={savedDraft.serverCertificatePin ?? ""}
                  onChange={(event) =>
                    setSavedDraft((current) => ({ ...current, serverCertificatePin: event.target.value }))
                  }
                />
              </label>
              <label>
                Username (optional)
                <input
                  value={savedDraft.username ?? ""}
                  onChange={(event) => setSavedDraft((current) => ({ ...current, username: event.target.value }))}
                  autoComplete="off"
                />
              </label>
              <label>
                Password (never saved)
                <input
                  type="password"
                  value={savedSecretForTarget(savedSecret, savedDraft.id) ?? ""}
                  onChange={(event) => setSavedSecret({ targetId: savedDraft.id, value: event.target.value })}
                  autoComplete="new-password"
                />
              </label>
              <div className="actions">
                <button
                  type="button"
                  onClick={() => void saveSaved()}
                  disabled={working || !savedDraft.name || !savedDraft.endpoint}
                >
                  Save Saved Connection
                </button>
                <button type="button" onClick={newSaved} disabled={working}>
                  New
                </button>
              </div>
            </section>
          )}
          {controllerRole === "controller" && (
            <section aria-labelledby="connection-heading">
              <h3 id="connection-heading">OPC UA Server connection</h3>
              <label>
                Endpoint URL
                <input
                  value={savedDraft.endpoint}
                  onChange={(event) => setSavedDraft((current) => ({ ...current, endpoint: event.target.value }))}
                  placeholder="opc.tcp://localhost:4840"
                />
              </label>
              <div className="actions">
                <button
                  type="button"
                  onClick={() => void discoverEndpoints()}
                  disabled={working || !savedDraft.endpoint}
                >
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
                      <button
                        type="button"
                        onClick={() => {
                          setSavedDraft((current) => ({
                            ...current,
                            endpoint: endpoint.endpointUrl,
                            securityMode: endpoint.securityMode,
                            securityPolicy: endpoint.securityPolicyUri,
                            serverCertificatePin: endpoint.serverCertificateFingerprint,
                          }));
                        }}
                      >
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
                  <li key={node.nodeId}>{node.displayName}</li>
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
                      <button type="button" onClick={() => setBrowseNodeId(reference.nodeId)}>
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
                        <button type="button" onClick={() => setBrowseNodeId(match.nodeId)}>
                          {match.displayName ?? match.browseName ?? match.nodeId}
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
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
