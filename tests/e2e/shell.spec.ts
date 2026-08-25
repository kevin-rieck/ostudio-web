import { expect, test } from "@playwright/test";

test("serves the React shell from the Node.js process", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Web workspace ready" })).toBeVisible();
  await expect(page.getByText("React is running in the browser.")).toBeVisible();
});
