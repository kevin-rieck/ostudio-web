import { expect, test } from "@playwright/test";

test("serves the React shell from the Node.js process", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Web workspace ready" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});

test("controller connects, browses and searches; observer follows and cannot operate", async ({ page, browser }) => {
  const { createOpcUaTestServer, disposeOpcUaTestServer } = await import("../../packages/node-opcua-adapter/src/test-fixture.js");
  const fixture = await createOpcUaTestServer();
  try {
  await fixture.server.start();
  await page.goto("/");
  const loginStatus = await page.evaluate(async () => {
    const response = await fetch("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "correct horse battery staple" }),
    });
    return response.status;
  });
  expect(loginStatus).toBe(204);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Troubleshooting Session" })).toBeVisible();
  await expect(page.getByText(/Read-Only Mode/)).toBeVisible();
  const takeover = page.getByRole("button", { name: "Take over control" });
  if (await takeover.isVisible()) await takeover.click();
  const observer = await browser.newContext();
  try {
    const other = await observer.newPage();
    await other.goto("/");
    await other.getByLabel("Password").fill("correct horse battery staple");
    await other.getByRole("button", { name: "Sign in" }).click();
    await expect(other.getByRole("heading", { name: "Troubleshooting Session" })).toBeVisible();
    await expect(other.getByRole("button", { name: "Discover endpoints" })).toHaveCount(0);
    await expect(other.getByRole("button", { name: "Browse", exact: true })).toHaveCount(0);
    await expect(other.getByRole("button", { name: "Disconnect", exact: true })).toHaveCount(0);
    await page.getByLabel("Endpoint URL").fill(fixture.endpointUrl);
    await page.getByRole("button", { name: "Discover endpoints" }).click();
    await expect(page.getByRole("button", { name: "Connect anonymously" })).toBeEnabled();
    await page.getByRole("button", { name: "Connect anonymously" }).click();
    await expect(page.getByText("SecurityPolicy None: OPC UA Server identity is unverified.")).toBeVisible();
    await expect(other.getByText("SecurityPolicy None: OPC UA Server identity is unverified.")).toBeVisible();
    await page.getByRole("button", { name: "Browse", exact: true }).click();
    await expect(page.getByRole("button", { name: "Objects", exact: true })).toBeVisible();
    await expect(other.getByRole("button", { name: "Discover endpoints" })).toHaveCount(0);
    await expect(other.getByText("Objects", { exact: true })).toBeVisible();
    await page.getByLabel("Address Space Search").fill("Objects");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.getByText(/[1-9]\d* result\(s\); coverage/)).toBeVisible();
    await expect(page.getByRole("list", { name: "Search matches" }).getByText("Objects")).toBeVisible();
    await page.getByRole("button", { name: "Disconnect", exact: true }).click();
    await expect(page.getByText(/Read-Only Mode/)).toBeVisible();
    await expect(page.getByRole("list", { name: "Search matches" })).toHaveCount(0);
    await expect(page.getByText(/disconnected · Controller/)).toBeVisible();
    await expect(other.getByText(/disconnected · Observer/)).toBeVisible();
    await expect(other.getByText(/Read-Only Mode/)).toBeVisible();
    await page.getByRole("button", { name: "Discover endpoints" }).click();
    await expect(page.getByRole("button", { name: "Connect anonymously" })).toBeEnabled();
    await fixture.server.shutdown();
    await page.getByRole("button", { name: "Connect anonymously" }).click();
    await expect(page.getByRole("region", { name: "Diagnostics" }).getByText(/connection_failed/)).toBeVisible();
  } finally {
    await observer.close();
  }
  } finally {
    await disposeOpcUaTestServer(fixture);
  }
});
