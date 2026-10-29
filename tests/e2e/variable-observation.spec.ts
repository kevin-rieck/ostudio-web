import { expect, test } from "@playwright/test";
import {
  addOpcUaTestVariable,
  createOpcUaTestServer,
  disposeOpcUaTestServer,
} from "../../packages/node-opcua-adapter/src/test-fixture.js";

const password = "correct horse battery staple";

async function ensureController(page: import("@playwright/test").Page): Promise<void> {
  const controller = page.getByText(/(?:connected|disconnected) · Controller · Read-Only Mode/);
  const recover = page.getByRole("button", { name: "Recover control", exact: true });
  const takeover = page.getByRole("button", { name: "Take over control", exact: true });
  await expect(controller.or(recover).or(takeover)).toBeVisible();
  if (await recover.isVisible()) await recover.click();
  else if (await takeover.isVisible()) await takeover.click();
  await expect(controller).toBeVisible();
}

async function establishDisconnectedController(page: import("@playwright/test").Page): Promise<void> {
  await ensureController(page);
  const disconnect = page.getByRole("button", { name: "Disconnect", exact: true });
  if ((await disconnect.isVisible()) && (await disconnect.isEnabled())) await disconnect.click();
  await expect(page.getByText(/disconnected · Controller · Read-Only Mode/)).toBeVisible();
}

async function boundedCleanup(action: Promise<unknown>): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([action, new Promise<void>((resolve) => (timeout = setTimeout(resolve, 3_000)))]);
  } catch {
    // Preserve the test failure; cleanup is best-effort and bounded.
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function disconnectAndSignOut(page: import("@playwright/test").Page): Promise<void> {
  const signOut = page.getByRole("button", { name: "Sign out", exact: true });
  await signOut.waitFor({ state: "visible", timeout: 5_000 }).catch(() => undefined);
  if (!(await signOut.isVisible())) return;
  await ensureController(page);
  const disconnect = page.getByRole("button", { name: "Disconnect", exact: true });
  if ((await disconnect.isVisible()) && (await disconnect.isEnabled())) await disconnect.click();
  await signOut.click();
}

test("direct and inspected Variable Node Watchlist adds avoid redundant metadata browsing", async ({ page }) => {
  const fixture = await createOpcUaTestServer();
  addOpcUaTestVariable(fixture, { browseName: "Temperature", nodeId: "ns=1;s=Temperature", initialValue: 21.5 });
  try {
    await fixture.server.start();
    await page.goto("/");
    await page.getByLabel("Username").fill("admin");
    await page.getByLabel("Admin password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await establishDisconnectedController(page);
    await page.getByLabel("Endpoint URL").fill(fixture.endpointUrl);
    await page.getByRole("button", { name: "Discover endpoints" }).click();
    await page.getByRole("button", { name: "Connect anonymously" }).click();
    const controllerGeneration = await page.evaluate(async (nodeId) => {
      const snapshot = await fetch("/api/v1/snapshot").then((response) => response.json());
      const response = await fetch(
        `/api/v1/watchlist/add?controllerGeneration=${snapshot.controller.controllerGeneration}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ nodeId }),
        },
      );
      if (!response.ok) throw new Error(`Direct Watchlist add failed: ${response.status}`);
      return snapshot.controller.controllerGeneration;
    }, "ns=1;s=Temperature");
    await page.evaluate(async (generation) => {
      await fetch(`/api/v1/watchlist/remove?controllerGeneration=${generation}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nodeId: "ns=1;s=Temperature" }),
      });
    }, controllerGeneration);
    await page.waitForTimeout(1_100);
    await page.getByRole("button", { name: "Browse", exact: true }).click();
    await page.getByRole("button", { name: "Objects", exact: true }).click();
    await page.waitForTimeout(1_100);
    await page.getByRole("button", { name: "Browse", exact: true }).click();
    await page.getByRole("button", { name: "Temperature", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Variable Node Inspection" })).toBeVisible();
    await expect(page.getByText("21.5", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Add to Watchlist" }).click();
    await expect(page.getByRole("button", { name: /Temperature: 21\.5/ })).toBeVisible();
  } finally {
    await disconnectAndSignOut(page);
    await disposeOpcUaTestServer(fixture);
  }
});

test("controller inspects and watches a Variable Node while observers follow, stale and resync", async ({
  page,
  browser,
}) => {
  const fixture = await createOpcUaTestServer();
  const variable = addOpcUaTestVariable(fixture, {
    browseName: "Temperature",
    nodeId: "ns=1;s=Temperature",
    initialValue: 21.5,
  });
  let observer: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  try {
    await fixture.server.start();
    await page.goto("/");
    await page.getByLabel("Username").fill("admin");
    await page.getByLabel("Admin password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await establishDisconnectedController(page);
    await page.getByLabel("Endpoint URL").fill(fixture.endpointUrl);
    await page.getByRole("button", { name: "Discover endpoints" }).click();
    await page.getByRole("button", { name: "Connect anonymously" }).click();
    await expect(page.getByText("SecurityPolicy None: OPC UA Server identity is unverified.")).toBeVisible();
    const objectAdd = await page.evaluate(async () => {
      const snapshot = await fetch("/api/v1/snapshot").then((response) => response.json());
      const response = await fetch(
        `/api/v1/watchlist/add?controllerGeneration=${snapshot.controller.controllerGeneration}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ nodeId: "i=85" }),
        },
      );
      return response.status;
    });
    expect(objectAdd).toBe(400);
    const directAdd = await page.evaluate(async (nodeId) => {
      const snapshot = await fetch("/api/v1/snapshot").then((response) => response.json());
      const response = await fetch(
        `/api/v1/watchlist/add?controllerGeneration=${snapshot.controller.controllerGeneration}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ nodeId }),
        },
      );
      return { status: response.status, snapshot: await response.json() };
    }, "ns=1;s=Temperature");
    expect(directAdd.status).toBe(200);
    expect(directAdd.snapshot.inspections["ns=1;s=Temperature"].liveValue.displayValue).toBe("21.5");
    const generation = directAdd.snapshot.controller.controllerGeneration;
    await page.evaluate(async (controllerGeneration) => {
      await fetch(`/api/v1/watchlist/remove?controllerGeneration=${controllerGeneration}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nodeId: "ns=1;s=Temperature" }),
      });
    }, generation);
    await page.waitForTimeout(1_100);
    await page.getByRole("button", { name: "Browse", exact: true }).click();
    await page.getByRole("button", { name: "Objects", exact: true }).click();
    await page.waitForTimeout(1_100);
    await page.getByRole("button", { name: "Browse", exact: true }).click();
    await page.getByRole("button", { name: "Temperature", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Variable Node Inspection" })).toBeVisible();
    await expect(page.getByRole("definition").filter({ hasText: "ns=1;s=Temperature" })).toBeVisible();
    await expect(page.getByText("21.5", { exact: true })).toBeVisible();
    await expect(page.getByText("Double", { exact: true })).toBeVisible();
    await expect(page.getByText("Good", { exact: true })).toBeVisible();
    await expect(page.getByText("Not reported (no engineering range metadata)")).toBeVisible();

    await page.route("**/api/v1/watchlist/add**", (route) =>
      route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          code: "watchlist_limit_reached",
          message: "The Watchlist limit has been reached.",
          correlationId: "cor-test",
        }),
      }),
    );
    await page.getByRole("button", { name: "Add to Watchlist" }).click();
    await expect(page.getByText("The Watchlist limit has been reached.", { exact: true })).toBeVisible();
    await page.unroute("**/api/v1/watchlist/add**");

    await page.getByRole("button", { name: "Add to Watchlist" }).click();
    await expect(page.getByRole("button", { name: /Temperature: 21\.5/ })).toBeVisible();
    observer = await browser.newContext();
    const other = await observer.newPage();
    await other.goto("/");
    await other.getByLabel("Username").fill("admin");
    await other.getByLabel("Admin password").fill(password);
    await other.getByRole("button", { name: "Sign in" }).click();
    await expect(other.getByText(/connected · Observer/)).toBeVisible();
    await expect(other.getByRole("button", { name: /Temperature: 21\.5/ })).toBeVisible();
    await expect(other.getByRole("button", { name: "Add to Watchlist" })).toHaveCount(0);
    await expect(other.getByRole("button", { name: "Remove", exact: true })).toHaveCount(0);
    await other.getByRole("button", { name: /Temperature: 21\.5/ }).click();
    await expect(other.getByRole("heading", { name: "Variable Node Inspection" })).toBeVisible();
    await expect(other.getByText("21.5", { exact: true })).toBeVisible();
    variable.setValue(23.75);
    await expect(page.getByRole("list", { name: "Session Trend" }).getByText(/23\.75/)).toBeVisible({
      timeout: 15_000,
    });
    await expect(other.getByRole("button", { name: /Temperature: 23\.75/ })).toBeVisible({ timeout: 15_000 });
    for (let value = 24; value <= 41; value += 1) {
      variable.setValue(value);
      await expect(page.getByRole("button", { name: new RegExp(`Temperature: ${value}(?: ·|$)`) })).toBeVisible({
        timeout: 5_000,
      });
      await page.waitForTimeout(1_000);
    }
    await expect(page.getByText(/connected · Controller · Read-Only Mode/)).toBeVisible();
    await expect(other.getByText(/connected · Observer · Read-Only Mode/)).toBeVisible();

    await page.context().setOffline(true);
    await expect(page.getByText(/Live Values are stale while OPC UA Studio resynchronizes/)).toBeVisible({
      timeout: 15_000,
    });
    await page.context().setOffline(false);
    await expect(page.getByText(/Live Values are stale while OPC UA Studio resynchronizes/)).toBeHidden({
      timeout: 15_000,
    });
    await expect(page.getByRole("button", { name: /Temperature: 41/ })).toBeVisible();
    await expect(page.getByText(/connected · Controller · Read-Only Mode/)).toBeVisible();

    await page.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(page.getByText("No Variable Nodes are in the Watchlist.")).toBeVisible();
    await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  } finally {
    await page
      .context()
      .setOffline(false)
      .catch(() => undefined);
    if (observer) await boundedCleanup(observer.close());
    await boundedCleanup(disconnectAndSignOut(page));
    await boundedCleanup(disposeOpcUaTestServer(fixture));
  }
});
