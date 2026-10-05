// @vitest-environment jsdom
//
// Regression: CodeBuddy CN/INTL are dual-auth (device-code OAuth + optional
// direct API key). Because they sit in FREE_APIKEY_PROVIDER_IDS, the dashboard's
// PAT-first flip (isOAuth = providerSupportsOAuth && !providerSupportsPat) used
// to surface ONLY the API-key modal — the device-code sign-in had no entry
// point, so free-tier accounts (no dashboard API keys) could not connect.
// These tests pin both entry points on the connections toolbar and the empty
// placeholder, mirroring 9router's dual-auth presentation.
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ConnectionsHeaderToolbar from "@/app/(dashboard)/dashboard/providers/[id]/components/ConnectionsHeaderToolbar";
import EmptyConnectionsPlaceholder from "@/app/(dashboard)/dashboard/providers/[id]/components/EmptyConnectionsPlaceholder";
import type { ProviderMessageTranslator } from "@/app/(dashboard)/dashboard/providers/[id]/providerPageHelpers";

const cleanups: Array<() => void> = [];

function renderComponent(node: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return container;
}

function buttonByText(container: HTMLElement, text: string) {
  return Array.from(container.querySelectorAll("button")).find((button) =>
    (button.textContent || "").includes(text)
  );
}

function clickInAct(button: Element | undefined) {
  if (!button) throw new Error("button not found");
  act(() => {
    (button as HTMLButtonElement).click();
  });
}

// providerText() falls back to its literal fallback when the translator lacks a
// `has` helper (see providerCredentialText.ts), so assertions match the English
// fallbacks regardless of the message catalog.
const t = ((key: string) => key) as unknown as ProviderMessageTranslator;

type ToolbarProps = React.ComponentProps<typeof ConnectionsHeaderToolbar>;
type PlaceholderProps = React.ComponentProps<typeof EmptyConnectionsPlaceholder>;

function toolbarProps(overrides: Partial<ToolbarProps> = {}): ToolbarProps {
  return {
    providerId: "codebuddy-intl",
    providerInfo: { name: "CodeBuddy International" },
    isCompatible: false,
    isCommandCode: false,
    isOAuth: false,
    providerSupportsPat: true,
    connections: [],
    batchTesting: false,
    batchRetesting: false,
    retestingId: null,
    proxyConfig: {},
    reorderingByAvailability: false,
    handleReorderByAvailability: () => {},
    preferClaudeCodeForUnprefixedClaudeModels: false,
    claudeRoutingSettingsLoaded: true,
    claudeRoutingSettingsLoadError: null,
    savingClaudeRoutingPreference: false,
    handleToggleClaudeRoutingPreference: () => {},
    loadClaudeRoutingSettings: async () => {},
    codexGlobalServiceMode: "default",
    codexGlobalServiceModeOptions: [],
    codexSettingsLoaded: true,
    codexSettingsLoadError: null,
    savingCodexGlobalServiceMode: false,
    handleChangeCodexGlobalServiceMode: () => {},
    loadCodexSettings: async () => {},
    onSetProxyTarget: () => {},
    handleDistributeProxies: () => {},
    handleBatchTestAll: () => {},
    gateConnectionFlow: (callback: () => void) => callback(),
    openApiKeyAddFlow: vi.fn(),
    openPrimaryAddFlow: vi.fn(),
    openExternalLinkFlow: () => {},
    handleOpenCommandCodeConnect: () => {},
    commandCodeAuthState: { phase: "idle" },
    onOpenOAuthModal: vi.fn(),
    onOpenCodexCliGuide: () => {},
    onOpenImportCodex: () => {},
    onOpenImportClaude: () => {},
    onOpenImportGemini: () => {},
    onOpenImportGrokCli: () => {},
    t,
    ...overrides,
  };
}

function placeholderProps(overrides: Partial<PlaceholderProps> = {}): PlaceholderProps {
  return {
    isOAuth: false,
    isCompatible: false,
    isCommandCode: false,
    providerId: "codebuddy-intl",
    providerSupportsPat: true,
    commandCodeAuthState: { phase: "idle" },
    gateConnectionFlow: (callback: () => void) => callback(),
    openApiKeyAddFlow: vi.fn(),
    openPrimaryAddFlow: vi.fn(),
    handleOpenCommandCodeConnect: () => {},
    onOpenOAuthModal: vi.fn(),
    onOpenImportCodex: () => {},
    onOpenImportClaude: () => {},
    onOpenImportGemini: () => {},
    onOpenImportGrokCli: () => {},
    t,
    ...overrides,
  };
}

describe("codebuddy dual-auth entry points", () => {
  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    while (cleanups.length) cleanups.pop()?.();
    document.body.innerHTML = "";
  });

  for (const providerId of ["codebuddy-cn", "codebuddy-intl"]) {
    it(`${providerId}: toolbar keeps OAuth sign-in reachable next to manual API key`, () => {
      const onOpenOAuthModal = vi.fn();
      const openApiKeyAddFlow = vi.fn();
      const container = renderComponent(
        <ConnectionsHeaderToolbar
          {...toolbarProps({ providerId, onOpenOAuthModal, openApiKeyAddFlow })}
        />
      );

      const oauthButton = buttonByText(container, "Sign in (OAuth)");
      const keyButton = buttonByText(container, "Manual API key");
      expect(oauthButton).toBeTruthy();
      expect(keyButton).toBeTruthy();

      clickInAct(oauthButton);
      expect(onOpenOAuthModal).toHaveBeenCalledTimes(1);
      expect(openApiKeyAddFlow).not.toHaveBeenCalled();

      clickInAct(keyButton);
      expect(openApiKeyAddFlow).toHaveBeenCalledTimes(1);
      expect(onOpenOAuthModal).toHaveBeenCalledTimes(1);
    });

    it(`${providerId}: empty placeholder keeps OAuth sign-in reachable`, () => {
      const onOpenOAuthModal = vi.fn();
      const container = renderComponent(
        <EmptyConnectionsPlaceholder {...placeholderProps({ providerId, onOpenOAuthModal })} />
      );

      const oauthButton = buttonByText(container, "Sign in (OAuth)");
      expect(oauthButton).toBeTruthy();
      expect(buttonByText(container, "Manual API key")).toBeTruthy();

      clickInAct(oauthButton);
      expect(onOpenOAuthModal).toHaveBeenCalledTimes(1);
    });
  }

  it("PAT-only free providers (opencode) keep the add-PAT flow without an OAuth button", () => {
    const container = renderComponent(
      <ConnectionsHeaderToolbar {...toolbarProps({ providerId: "opencode" })} />
    );
    expect(buttonByText(container, "Add PAT")).toBeTruthy();
    expect(buttonByText(container, "Sign in (OAuth)")).toBeUndefined();
  });

  it("qoder keeps its existing Add PAT + Experimental OAuth pairing", () => {
    const container = renderComponent(
      <ConnectionsHeaderToolbar {...toolbarProps({ providerId: "qoder" })} />
    );
    expect(buttonByText(container, "Add PAT")).toBeTruthy();
    expect(buttonByText(container, "Experimental OAuth")).toBeTruthy();
    expect(buttonByText(container, "Sign in (OAuth)")).toBeUndefined();
  });
});
