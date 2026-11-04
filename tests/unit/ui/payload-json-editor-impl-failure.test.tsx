// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("jsoneditor", () => ({
  default: class FailingJSONEditor {
    constructor() {
      throw new Error("jsoneditor constructor failed");
    }
  },
}));

import PayloadJsonEditorImpl from "@/shared/components/PayloadJsonEditorImpl";
import { PAYLOAD_EDITOR_FAILURE_MESSAGE } from "@/shared/utils/payloadEditorMode";

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timed out");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
  }
}

describe("PayloadJsonEditorImpl failure handling", () => {
  const roots: Array<{ root: ReturnType<typeof createRoot>; container: HTMLDivElement }> = [];

  afterEach(async () => {
    for (const { root, container } of roots.splice(0)) {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it("renders an escaped fallback and never logs the payload when initialization fails", async () => {
    const marker = 'sensitive-marker</pre><script>alert("x")</script>';
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push({ root, container });

    await act(async () => {
      root.render(<PayloadJsonEditorImpl jsonText={JSON.stringify({ marker })} />);
    });
    await waitFor(() =>
      Boolean(container.querySelector('[data-testid="payload-json-editor-fallback"]'))
    );

    const fallback = container.querySelector('[data-testid="payload-json-editor-fallback"]');
    expect(fallback?.textContent).toContain("Viewer unavailable");
    expect(fallback?.textContent).toContain("sensitive-marker</pre>");
    expect(fallback?.querySelector("script")).toBeNull();
    expect(container.querySelector("button")?.textContent).toBe("Retry");
    expect(container.querySelector('[data-testid="payload-json-editor"]')?.childElementCount).toBe(
      0
    );
    expect(consoleError).toHaveBeenCalledWith(PAYLOAD_EDITOR_FAILURE_MESSAGE);
    expect(consoleError.mock.calls.flat().join(" ")).not.toContain("sensitive-marker");

    consoleError.mockRestore();
  });
});
