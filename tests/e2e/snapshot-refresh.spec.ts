import { expect, test } from "@playwright/test";

test("slow snapshots progress during events and interrupted responses stay stale", async ({ page }) => {
  await page.addInitScript(() => {
    const sources: MockEventSource[] = [];
    class MockEventSource {
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      closed = false;
      constructor() {
        sources.push(this);
        setTimeout(() => this.onopen?.(), 0);
      }
      close() {
        this.closed = true;
      }
    }
    window.EventSource = MockEventSource as unknown as typeof EventSource;
    const state = window as unknown as { emitSnapshotEvent: () => void; sourceCount: () => number };
    state.emitSnapshotEvent = () => {
      const source = sources.at(-1);
      if (!source?.closed) source?.onmessage?.({ data: JSON.stringify({ type: "changed", payload: {} }) });
    };
    state.sourceCount = () => sources.length;
  });

  await page.route("**/api/v1/auth/session", (route) =>
    route.fulfill({ json: { authenticated: true, insecureDevelopment: false } }),
  );
  await page.route("**/api/v1/controller/attach", (route) =>
    route.fulfill({ json: { role: "observer", controllerGeneration: 1 } }),
  );
  await page.route("**/api/v1/diagnostics", (route) => route.fulfill({ json: [] }));

  let sequence = 0;
  let failNext = false;
  let mode: "normal" | "old" | "fresh" = "normal";
  let releaseOld!: () => void;
  let releaseFresh!: () => void;
  let oldStarted!: () => void;
  let freshStarted!: () => void;
  const oldGate = new Promise<void>((resolve) => (releaseOld = resolve));
  const freshGate = new Promise<void>((resolve) => (releaseFresh = resolve));
  const oldRequest = new Promise<void>((resolve) => (oldStarted = resolve));
  const freshRequest = new Promise<void>((resolve) => (freshStarted = resolve));
  await page.route("**/api/v1/snapshot", async (route) => {
    if (failNext) {
      failNext = false;
      await route.fulfill({ status: 500, json: { message: "Snapshot failed" } });
      return;
    }
    const requestMode = mode;
    const value = requestMode === "normal" ? String(++sequence) : requestMode;
    if (requestMode === "old") {
      mode = "fresh";
      oldStarted();
      await oldGate;
    } else if (requestMode === "fresh") {
      freshStarted();
      await freshGate;
    } else {
      await new Promise((resolve) => setTimeout(resolve, 180));
    }
    await route.fulfill({
      json: {
        sequence,
        buildVersion: "test",
        generatedAt: "2026-01-01T00:00:00Z",
        controller: { role: "observer", controllerGeneration: 1 },
        safety: { readOnly: true, safetyGeneration: 1 },
        connection: { state: "connected" },
        nodes: [
          { nodeId: "temperature", nodeClass: "Variable", browseName: "Temperature", displayName: "Temperature" },
        ],
        watchlist: ["temperature"],
        inspections: { temperature: { nodeId: "temperature", liveValue: { displayValue: value, status: "Good" } } },
        trends: {},
      },
    });
  });

  await page.goto("/");
  const watch = page.getByRole("button", { name: /Temperature:/ });
  await expect(watch).toBeVisible();
  await page.waitForTimeout(400);
  const initial = await watch.textContent();
  await page.evaluate(() => {
    const state = window as unknown as { emitSnapshotEvent: () => void; eventTimer: number };
    state.eventTimer = window.setInterval(state.emitSnapshotEvent, 50);
  });
  await expect(watch).not.toHaveText(initial!, { timeout: 3_000 });
  expect(await page.evaluate(() => (window as unknown as { eventTimer: number }).eventTimer)).toBeGreaterThan(0);
  const sourceCount = await page.evaluate(() => (window as unknown as { sourceCount: () => number }).sourceCount());
  failNext = true;
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { sourceCount: () => number }).sourceCount()), {
      timeout: 5_000,
    })
    .toBeGreaterThan(sourceCount);
  await expect(page.getByText(/Live Values are stale while OPC UA Studio resynchronizes/)).toBeHidden();
  await page.evaluate(() => window.clearInterval((window as unknown as { eventTimer: number }).eventTimer));
  await page.waitForTimeout(500);

  mode = "old";
  await page.evaluate(() => (window as unknown as { emitSnapshotEvent: () => void }).emitSnapshotEvent());
  await oldRequest;
  await page.evaluate(() => {
    window.dispatchEvent(new Event("offline"));
    window.dispatchEvent(new Event("online"));
  });
  await expect(page.getByText(/Live Values are stale while OPC UA Studio resynchronizes/)).toBeVisible();
  releaseOld();
  await freshRequest;
  await expect(watch).not.toContainText("old");
  await expect(page.getByText(/Live Values are stale while OPC UA Studio resynchronizes/)).toBeVisible();
  releaseFresh();
  await expect(watch).toContainText("fresh");
  await expect(page.getByText(/Live Values are stale while OPC UA Studio resynchronizes/)).toBeHidden();
});
