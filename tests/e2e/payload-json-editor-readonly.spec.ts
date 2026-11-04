/**
 * Behavioural regression for the call-log payload viewer (ID-001).
 *
 * The unit tests only cover mode resolution and the SSR placeholder. This spec
 * drives the real dashboard with intercepted call-log APIs so the read-only
 * contract, Copy/collapse controls, and theme legibility are exercised in a
 * browser.
 */
import { test, expect } from "@playwright/test";
import { gotoDashboardRoute } from "./helpers/dashboardAuth";

const logSummary = {
  id: "e2e-payload-log",
  status: 200,
  method: "POST",
  path: "/v1/chat/completions",
  timestamp: "2026-11-04T08:00:00.000Z",
  duration: 42,
  provider: "openai",
  sourceFormat: "openai-chat",
  model: "gpt-4o",
  requestedModel: "openai/gpt-4o",
  tokens: { in: 12, out: 3, cacheRead: null, cacheWrite: null, reasoning: null },
};

const smallPayload = {
  method: "POST",
  url: "https://api.openai.com/v1/chat/completions",
  headers: { "content-type": "application/json" },
  body: { model: "gpt-4o", messages: [{ role: "user", content: "hello" }] },
};

const bigPayload = {
  messages: Array.from({ length: 700 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `Message ${index}: ` + "lorem ipsum dolor sit amet consectetur ".repeat(6),
  })),
};

test("payload viewer is read-only, keeps Copy/collapse, and stays legible in dark mode", async ({
  page,
}) => {
  await page.route("**/api/provider-nodes", (route) => route.fulfill({ json: { nodes: [] } }));
  await page.route("**/api/logs/detail?limit=1", (route) =>
    route.fulfill({ json: { enabled: true } })
  );
  await page.route("**/api/usage/call-logs**", (route) => route.fulfill({ json: [logSummary] }));
  await page.route("**/api/logs/e2e-payload-log", (route) =>
    route.fulfill({
      json: {
        ...logSummary,
        pipelinePayloads: {
          clientRawRequest: smallPayload,
          providerResponse: bigPayload,
        },
      },
    })
  );

  await gotoDashboardRoute(page, "/dashboard/logs");

  const row = page.locator("tbody tr").filter({ hasText: "gpt-4o" }).first();
  await expect(row).toBeVisible({ timeout: 60_000 });
  await row.click();

  const treeEditor = page.locator('[data-testid="payload-json-editor"][data-mode="tree"]');
  const textEditor = page.locator('[data-testid="payload-json-editor"][data-mode="text"]');
  await expect(treeEditor).toBeVisible({ timeout: 60_000 });
  await expect(textEditor).toBeVisible({ timeout: 60_000 });
  await expect(treeEditor.locator(".jsoneditor-tree").first()).toBeVisible();

  // No mutation toolbar and no per-node action menu.
  await expect(treeEditor.locator(".jsoneditor-menu")).toHaveCount(0);
  await expect(page.locator("button.jsoneditor-transform")).toHaveCount(0);
  await expect(page.locator("button.jsoneditor-sort")).toHaveCount(0);
  const contextButton = treeEditor.locator("button.jsoneditor-contextmenu-button").first();
  if ((await contextButton.count()) > 0) {
    await expect(contextButton).toBeHidden();
  }

  // Mutating shortcuts must not change the displayed tree.
  const tree = treeEditor.locator(".jsoneditor-tree").first();
  const treeBefore = await tree.innerText();
  await treeEditor.locator(".jsoneditor-field").first().click();
  for (const combo of [
    "Control+d",
    "Control+Delete",
    "Control+Insert",
    "Control+m",
    "Alt+Shift+ArrowLeft",
    "Alt+Shift+ArrowUp",
  ]) {
    await page.keyboard.press(combo);
  }
  await treeEditor.locator(".jsoneditor-field").first().click({ button: "right" });
  expect(await tree.innerText()).toBe(treeBefore);

  // Mutating shortcuts must not change the displayed text either.
  const textarea = textEditor.locator("textarea.jsoneditor-text");
  await expect(textarea).toBeVisible();
  const textBefore = await textarea.inputValue();
  await textarea.click();
  await page.keyboard.press("Control+i");
  await page.keyboard.press("Control+Shift+I");
  await expect(textarea).toHaveValue(textBefore);

  // Dark-mode readability: the vendor's dark-on-dark summary and dark-green URL
  // must be overridden. Assert WCAG AA contrast rather than a fixed palette value.
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await expect(treeEditor.locator(".jsoneditor-tree").first()).toBeVisible();
  const contrast = await page.evaluate(() => {
    const parse = (value: string) => {
      const match = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
    };
    const luminance = (rgb: number[]) => {
      const channel = (value: number) => {
        const c = value / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
    };
    const ratio = (foreground: string, background: string) => {
      const fg = parse(foreground);
      const bg = parse(background);
      if (!fg || !bg) return 0;
      const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
      return (hi + 0.05) / (lo + 0.05);
    };
    const tree = document.querySelector(
      ".payload-jsoneditor-wrapper .jsoneditor-tree"
    ) as HTMLElement | null;
    const summary = document.querySelector(
      ".payload-jsoneditor-wrapper .jsoneditor-readonly"
    ) as HTMLElement | null;
    const url = document.querySelector(
      ".payload-jsoneditor-wrapper .jsoneditor-value.jsoneditor-url"
    ) as HTMLElement | null;
    const treeBackground = tree ? getComputedStyle(tree).backgroundColor : "rgb(255, 255, 255)";
    return {
      summary: summary ? ratio(getComputedStyle(summary).color, treeBackground) : 0,
      url: url ? ratio(getComputedStyle(url).color, treeBackground) : 0,
    };
  });
  expect(contrast.summary).toBeGreaterThanOrEqual(4.5);
  expect(contrast.url).toBeGreaterThanOrEqual(4.5);

  // Copy and collapse still work.
  await page.getByRole("button", { name: "Copy Client Raw Request" }).click();
  await expect(page.getByRole("button", { name: "Copy Client Raw Request" })).toContainText(
    "Copied!"
  );
  await page.getByRole("button", { name: "Collapse Client Raw Request" }).click();
  await expect(page.getByRole("button", { name: "Expand Client Raw Request" })).toBeVisible();
});
