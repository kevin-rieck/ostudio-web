import { expect, test } from "@playwright/test";
import type { SavedConnection, SavedConnectionRequest } from "@ostudio/contracts";

test("explicit certificate review acceptance is saved before reconnect is enabled", async ({ page }) => {
  let connection: SavedConnection = {
    id: "legacy",
    name: "Legacy PLC",
    endpoint: "opc.tcp://plc:4840",
    securityPolicy: "Basic256Sha256",
    securityMode: "SignAndEncrypt",
    certificateReviewRequired: true,
  };
  const requests: SavedConnectionRequest[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/saved-connections/legacy") {
      const body = route.request().postDataJSON() as SavedConnectionRequest;
      requests.push(body);
      connection = { ...body, id: "legacy" };
      await route.fulfill({ status: 204 });
    } else if (url.pathname === "/api/v1/saved-connections") {
      await route.fulfill({ json: { mode: "durable", savedConnections: [connection] } });
    } else if (url.pathname === "/api/v1/snapshot") {
      await route.fulfill({
        json: {
          sequence: 0,
          buildVersion: "test",
          generatedAt: new Date(0).toISOString(),
          controller: { role: "controller", controllerGeneration: 1 },
          safety: { readOnly: true, safetyGeneration: 1 },
          connection: { state: "disconnected" },
          nodes: [],
        },
      });
    } else if (url.pathname === "/api/v1/events") {
      await route.fulfill({ contentType: "text/event-stream", body: "" });
    } else if (url.pathname === "/api/v1/diagnostics") {
      await route.fulfill({ json: [] });
    } else {
      await route.fulfill({
        json: { authenticated: true, insecureDevelopment: false, role: "controller", controllerGeneration: 1 },
      });
    }
  });
  await page.goto("/");
  const reconnect = page.getByRole("button", { name: "Reconnect", exact: true });
  await expect(reconnect).toBeDisabled();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByLabel("Server certificate SHA-256 pin").fill(`sha256:${"a".repeat(64)}`);
  await page.getByRole("button", { name: "Accept reviewed certificate details" }).click();
  await expect(reconnect).toBeDisabled();
  await page.getByRole("button", { name: "Save Saved Connection", exact: true }).click();
  await expect(reconnect).toBeEnabled();
  expect(requests).toHaveLength(1);
  expect(requests[0]).not.toHaveProperty("certificateReviewRequired");
  expect(requests[0]?.serverCertificatePin).toBe(`sha256:${"a".repeat(64)}`);
});
