import { useEffect, useState, type FormEvent } from "react";
import { ApiClientError, createApiClient, type Snapshot } from "@ostudio/contracts";

const api = createApiClient();

export function App() {
  const [authenticated, setAuthenticated] = useState(false);
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | undefined>();
  const [insecureDevelopment, setInsecureDevelopment] = useState(false);
  const [controllerRole, setControllerRole] = useState<"controller" | "observer">("observer");
  const [snapshot, setSnapshot] = useState<Snapshot>();

  useEffect(() => {
    void api.getAuthenticationSession()
      .then((session) => {
        setAuthenticated(session.authenticated);
        setInsecureDevelopment(session.insecureDevelopment);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!authenticated) {
      setControllerRole("observer");
      setSnapshot(undefined);
      return;
    }
    let stopped = false;
    let connecting = false;
    let source: EventSource | undefined;
    let renewTimer: number | undefined;
    let retryTimer: number | undefined;
    let controllerGeneration: number | undefined;
    let startRenewal = (): void => undefined;
    const stopRenewal = (): void => {
      if (renewTimer !== undefined) window.clearInterval(renewTimer);
      renewTimer = undefined;
    };
    const retry = (connectEvents: () => Promise<void>): void => {
      if (!stopped && retryTimer === undefined) retryTimer = window.setTimeout(() => { retryTimer = undefined; void connectEvents(); }, 1_000);
    };
    const refreshSnapshot = async (): Promise<Snapshot> => {
      const current = await api.getSnapshot();
      if (!stopped) {
        setSnapshot(current);
        setControllerRole(current.controller.role);
        controllerGeneration = current.controller.controllerGeneration;
        if (current.controller.role === "observer") stopRenewal();
        else startRenewal();
      }
      return current;
    };
    startRenewal = (): void => {
      stopRenewal();
      if (controllerGeneration === undefined) return;
      renewTimer = window.setInterval(() => {
        void api.renewControllerLease(controllerGeneration!).catch(() => {
          stopRenewal();
          setControllerRole("observer");
        });
      }, 5_000);
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
        eventSource.onmessage = (message) => {
          try {
            JSON.parse(message.data) as { type?: string };
            void refreshSnapshot();
          } catch {
            eventSource.close();
            if (source === eventSource) source = undefined;
            retry(connectEvents);
          }
        };
        eventSource.onerror = () => {
          eventSource.close();
          if (source === eventSource) source = undefined;
          retry(connectEvents);
        };
      } catch {
        retry(connectEvents);
      } finally {
        connecting = false;
      }
    };
    void api.attachController().then((controller) => {
      if (stopped) return;
      setControllerRole(controller.role);
      controllerGeneration = controller.controllerGeneration;
      if (controller.role === "controller") startRenewal();
      void connectEvents();
    }).catch(() => {
      setControllerRole("observer");
      void connectEvents();
    });
    return () => {
      stopped = true;
      source?.close();
      stopRenewal();
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
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
      setMessage(error instanceof ApiClientError ? error.message : "Sign-in failed.");
    }
  }

  async function takeOver(): Promise<void> {
    setMessage(undefined);
    try {
      const controller = await api.takeOverController();
      setControllerRole(controller.role);
    } catch (error) {
      setMessage(error instanceof ApiClientError ? error.message : "Control transfer failed.");
    }
  }

  async function logout(): Promise<void> {
    setMessage(undefined);
    try {
      await api.logoutAdmin();
      setAuthenticated(false);
      setPassword("");
    } catch (error) {
      setMessage(error instanceof ApiClientError ? error.message : "Sign-out failed.");
    }
  }

  return (
    <main className="shell">
      <p className="eyebrow">OPC UA Studio</p>
      <h1>Web workspace ready</h1>
      <p>React is running in the browser.</p>
      {insecureDevelopment && <p className="warning" role="status">Insecure development mode is enabled. Do not expose this server publicly.</p>}
      {authenticated ? (
        <>
          <h2>Troubleshooting Session</h2>
          <p>Authentication succeeded. This browser is ready for OPC UA Studio.</p>
          <p role="status">{snapshot?.connection.state ?? "disconnected"} · {controllerRole === "controller" ? "Controller" : "Observer"}</p>
          {controllerRole === "observer" && <button type="button" onClick={() => void takeOver()}>Take over control</button>}
          <button type="button" onClick={() => void logout()}>Sign out</button>
        </>
      ) : (
        <>
          <h2>Sign in</h2>
          <form onSubmit={login}>
            <label>
              Username
              <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required />
            </label>
            <label>
              Admin password
              <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required />
            </label>
            <button type="submit">Sign in</button>
          </form>
        </>
      )}
      {message && <p className="error" role="alert">{message}</p>}
    </main>
  );
}
