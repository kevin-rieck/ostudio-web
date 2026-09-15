import { useEffect, useState, type FormEvent } from "react";
import { ApiClientError, createApiClient } from "@ostudio/contracts";

const api = createApiClient();

export function App() {
  const [authenticated, setAuthenticated] = useState(false);
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | undefined>();
  const [insecureDevelopment, setInsecureDevelopment] = useState(false);

  useEffect(() => {
    void api
      .getAuthenticationSession()
      .then((session) => {
        setAuthenticated(session.authenticated);
        setInsecureDevelopment(session.insecureDevelopment);
      })
      .catch(() => undefined);
  }, []);

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
      {insecureDevelopment && (
        <p className="warning" role="status">
          Insecure development mode is enabled. Do not expose this server publicly.
        </p>
      )}
      {authenticated ? (
        <>
          <h2>Troubleshooting Session</h2>
          <p>Authentication succeeded. This browser is ready for OPC UA Studio.</p>
          <button type="button" onClick={() => void logout()}>
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
