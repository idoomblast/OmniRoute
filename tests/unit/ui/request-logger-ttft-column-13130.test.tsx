// @vitest-environment jsdom
/**
 * #13130 UI wiring: the Logs page must expose an opt-in TTFT column and use
 * generation-time TPS. This mounts the real RequestLoggerV2, verifies the
 * column starts hidden, then enables it through the column picker and asserts
 * the rendered TTFT value plus the TPS tooltip breakdown.
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/logs",
}));

vi.mock("@/store/emailPrivacyStore", () => ({
  default: () => ({ emailsVisible: true }),
}));

const RequestLoggerV2 = (await import("../../../src/shared/components/RequestLoggerV2.tsx"))
  .default;

class FakeIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/usage/call-logs")) {
        return Response.json([
          {
            id: "log-ttft-1",
            timestamp: new Date().toISOString(),
            method: "POST",
            path: "/v1/chat/completions",
            status: 200,
            model: "ttft-test-model",
            provider: "kenari",
            account: "main",
            duration: 10_000,
            ttft: 4_000,
            tokens: { in: 10, out: 300, reasoning: 0 },
          },
        ]);
      }
      if (url.startsWith("/api/provider-nodes")) {
        return Response.json({ nodes: [] });
      }
      if (url.startsWith("/api/logs/detail")) {
        return Response.json({ enabled: false });
      }
      return Response.json({});
    })
  );
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root.unmount();
    });
  }
  container?.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("RequestLoggerV2 TTFT column (#13130)", () => {
  it("keeps TTFT opt-in, then renders the value and generation-time TPS tooltip", async () => {
    await act(async () => {
      root.render(<RequestLoggerV2 />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const headers = () =>
      Array.from(container.querySelectorAll("table thead th")).map((th) => th.textContent?.trim());

    // Default: opt-in, because old rows predate ttft_ms.
    expect(headers()).not.toContain("columns.ttft");

    const toggle = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "columns.ttft"
    );
    expect(toggle).toBeTruthy();

    await act(async () => {
      toggle?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(headers()).toContain("columns.ttft");

    const row = Array.from(container.querySelectorAll("table tbody tr")).find((tr) =>
      tr.textContent?.includes("ttft-test-model")
    );
    expect(row).toBeTruthy();

    const cells = Array.from(row?.querySelectorAll("td") ?? []).map((td) => td.textContent?.trim());
    expect(cells).toContain("4.0s");

    const tpsSpan = Array.from(row?.querySelectorAll("span") ?? []).find(
      (span) => span.textContent?.trim() === "50.0"
    );
    expect(tpsSpan).toBeTruthy();
    expect(tpsSpan?.title).toContain("TTFT 4.0s");
    expect(tpsSpan?.title).toContain("generation 6.0s");
  });
});
