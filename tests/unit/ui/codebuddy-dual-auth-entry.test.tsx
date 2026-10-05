// @vitest-environment jsdom
//
// Regression: CodeBuddy CN/INTL are dual-auth (device-code OAuth + optional
// direct API key). Because they sit in FREE_APIKEY_PROVIDER_IDS, the dashboard's
// PAT-first flip (isOAuth = providerSupportsOAuth && !providerSupportsPat) used
// to surface ONLY the API-key modal — the device-code sign-in had no entry
// point, so free-tier accounts (no dashboard API keys) could not connect.
// These tests pin both entry points on the connections toolbar and the empty
// placeholder, mirroring 9router's dual-auth presentation, and pin the
// surrounding control providers (opencode, qoder, OAuth-only gemini) on BOTH
// components. Every control case asserts the COMPLETE connection-entry
// inventory (toolbar utilities excluded) plus full callback counts after each
// click, so the dual-auth branch cannot hide (or leak into) neighbouring entry
// flows.
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

function buttons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll("button"));
}

function buttonByText(container: HTMLElement, text: string) {
  return buttons(container).find((button) => (button.textContent || "").includes(text));
}

function countByText(container: HTMLElement, text: string): number {
  return buttons(container).filter((button) => (button.textContent || "").includes(text)).length;
}

// Toolbar decorations that are never connection entries: the provider-proxy
// utility (icon "vpn_lock" + t("providerProxy") → text "vpn_lockproviderProxy"
// with unconfigured proxyConfig) and the distribute-proxies helper rendered
// once connections exist ("swap_horizDistribute Proxies"). The empty
// placeholder renders no utility buttons at all.
const NON_ENTRY_BUTTON_TEXTS = ["providerProxy", "Distribute Proxies"];

function entryButtons(container: HTMLElement): HTMLButtonElement[] {
  return buttons(container).filter(
    (button) => !NON_ENTRY_BUTTON_TEXTS.some((text) => (button.textContent || "").includes(text))
  );
}

// Complete connection-entry inventory: exactly one entry button per expected
// label, and no other entry button beyond them.
function expectEntryInventory(container: HTMLElement, labels: string[]) {
  const entries = entryButtons(container);
  expect(entries).toHaveLength(labels.length);
  for (const label of labels) {
    const matches = entries.filter((button) => (button.textContent || "").includes(label));
    expect(matches).toHaveLength(1);
  }
}

function clickInAct(button: Element | undefined) {
  if (!button) throw new Error("button not found");
  act(() => {
    (button as HTMLButtonElement).click();
  });
}

// providerText() falls back to its literal fallback when the translator lacks a
// `has` helper (see providerCredentialText.ts), so assertions match the English
// fallbacks regardless of the message catalog. Raw t() calls (e.g. t("add"))
// return the key itself with this passthrough translator.
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
    it(`${providerId}: toolbar keeps OAuth sign-in reachable next to manual API key (no connections)`, () => {
      const onOpenOAuthModal = vi.fn();
      const openApiKeyAddFlow = vi.fn();
      const openPrimaryAddFlow = vi.fn();
      const container = renderComponent(
        <ConnectionsHeaderToolbar
          {...toolbarProps({
            providerId,
            onOpenOAuthModal,
            openApiKeyAddFlow,
            openPrimaryAddFlow,
          })}
        />
      );

      expectEntryInventory(container, ["Sign in (OAuth)", "Manual API key"]);

      const oauthButton = buttonByText(container, "Sign in (OAuth)");
      const keyButton = buttonByText(container, "Manual API key");

      clickInAct(oauthButton);
      expect(onOpenOAuthModal).toHaveBeenCalledTimes(1);
      expect(openApiKeyAddFlow).not.toHaveBeenCalled();
      expect(openPrimaryAddFlow).not.toHaveBeenCalled();

      clickInAct(keyButton);
      expect(openApiKeyAddFlow).toHaveBeenCalledTimes(1);
      expect(onOpenOAuthModal).toHaveBeenCalledTimes(1);
      expect(openPrimaryAddFlow).not.toHaveBeenCalled();
    });

    it(`${providerId}: toolbar keeps both entry points with an existing connection`, () => {
      const onOpenOAuthModal = vi.fn();
      const openApiKeyAddFlow = vi.fn();
      const openPrimaryAddFlow = vi.fn();
      const container = renderComponent(
        <ConnectionsHeaderToolbar
          {...toolbarProps({
            providerId,
            connections: [{ id: "conn-1" }],
            onOpenOAuthModal,
            openApiKeyAddFlow,
            openPrimaryAddFlow,
          })}
        />
      );

      expectEntryInventory(container, ["Sign in (OAuth)", "Manual API key"]);

      clickInAct(buttonByText(container, "Sign in (OAuth)"));
      expect(onOpenOAuthModal).toHaveBeenCalledTimes(1);
      expect(openApiKeyAddFlow).not.toHaveBeenCalled();
      expect(openPrimaryAddFlow).not.toHaveBeenCalled();

      clickInAct(buttonByText(container, "Manual API key"));
      expect(openApiKeyAddFlow).toHaveBeenCalledTimes(1);
      expect(onOpenOAuthModal).toHaveBeenCalledTimes(1);
      expect(openPrimaryAddFlow).not.toHaveBeenCalled();
    });

    it(`${providerId}: empty placeholder keeps OAuth sign-in reachable and manual-key dispatch separate`, () => {
      const onOpenOAuthModal = vi.fn();
      const openApiKeyAddFlow = vi.fn();
      const openPrimaryAddFlow = vi.fn();
      const container = renderComponent(
        <EmptyConnectionsPlaceholder
          {...placeholderProps({
            providerId,
            onOpenOAuthModal,
            openApiKeyAddFlow,
            openPrimaryAddFlow,
          })}
        />
      );

      expectEntryInventory(container, ["Sign in (OAuth)", "Manual API key"]);

      clickInAct(buttonByText(container, "Sign in (OAuth)"));
      expect(onOpenOAuthModal).toHaveBeenCalledTimes(1);
      expect(openApiKeyAddFlow).not.toHaveBeenCalled();
      expect(openPrimaryAddFlow).not.toHaveBeenCalled();

      // Manual-key click must fire ONLY the API-key callback (separation).
      clickInAct(buttonByText(container, "Manual API key"));
      expect(openApiKeyAddFlow).toHaveBeenCalledTimes(1);
      expect(onOpenOAuthModal).toHaveBeenCalledTimes(1);
      expect(openPrimaryAddFlow).not.toHaveBeenCalled();
    });
  }

  it("PAT-only free providers (opencode): toolbar keeps exactly the add-PAT entry", () => {
    const openPrimaryAddFlow = vi.fn();
    const openApiKeyAddFlow = vi.fn();
    const onOpenOAuthModal = vi.fn();
    const container = renderComponent(
      <ConnectionsHeaderToolbar
        {...toolbarProps({
          providerId: "opencode",
          openPrimaryAddFlow,
          openApiKeyAddFlow,
          onOpenOAuthModal,
        })}
      />
    );

    expectEntryInventory(container, ["Add PAT"]);
    expect(countByText(container, "Sign in (OAuth)")).toBe(0);
    expect(countByText(container, "Manual API key")).toBe(0);
    expect(countByText(container, "Experimental OAuth")).toBe(0);

    clickInAct(buttonByText(container, "Add PAT"));
    expect(openPrimaryAddFlow).toHaveBeenCalledTimes(1);
    expect(openApiKeyAddFlow).not.toHaveBeenCalled();
    expect(onOpenOAuthModal).not.toHaveBeenCalled();
  });

  it("PAT-only free providers (opencode): placeholder keeps exactly the add-PAT entry", () => {
    const openPrimaryAddFlow = vi.fn();
    const openApiKeyAddFlow = vi.fn();
    const onOpenOAuthModal = vi.fn();
    const container = renderComponent(
      <EmptyConnectionsPlaceholder
        {...placeholderProps({
          providerId: "opencode",
          providerSupportsPat: true,
          isOAuth: false,
          openPrimaryAddFlow,
          openApiKeyAddFlow,
          onOpenOAuthModal,
        })}
      />
    );

    expectEntryInventory(container, ["Add PAT"]);
    expect(countByText(container, "Sign in (OAuth)")).toBe(0);
    expect(countByText(container, "Manual API key")).toBe(0);
    expect(countByText(container, "Experimental OAuth")).toBe(0);

    clickInAct(buttonByText(container, "Add PAT"));
    expect(openPrimaryAddFlow).toHaveBeenCalledTimes(1);
    expect(openApiKeyAddFlow).not.toHaveBeenCalled();
    expect(onOpenOAuthModal).not.toHaveBeenCalled();
  });

  it("qoder keeps its existing Add PAT + Experimental OAuth pairing on the toolbar", () => {
    const openPrimaryAddFlow = vi.fn();
    const openApiKeyAddFlow = vi.fn();
    const onOpenOAuthModal = vi.fn();
    const container = renderComponent(
      <ConnectionsHeaderToolbar
        {...toolbarProps({
          providerId: "qoder",
          openPrimaryAddFlow,
          openApiKeyAddFlow,
          onOpenOAuthModal,
        })}
      />
    );

    expectEntryInventory(container, ["Add PAT", "Experimental OAuth"]);
    expect(countByText(container, "Sign in (OAuth)")).toBe(0);
    expect(countByText(container, "Manual API key")).toBe(0);

    clickInAct(buttonByText(container, "Add PAT"));
    expect(openPrimaryAddFlow).toHaveBeenCalledTimes(1);
    expect(onOpenOAuthModal).not.toHaveBeenCalled();
    expect(openApiKeyAddFlow).not.toHaveBeenCalled();

    clickInAct(buttonByText(container, "Experimental OAuth"));
    expect(openPrimaryAddFlow).toHaveBeenCalledTimes(1);
    expect(onOpenOAuthModal).toHaveBeenCalledTimes(1);
    expect(openApiKeyAddFlow).not.toHaveBeenCalled();
  });

  it("qoder keeps its existing Add PAT + Experimental OAuth pairing on the placeholder", () => {
    const openPrimaryAddFlow = vi.fn();
    const openApiKeyAddFlow = vi.fn();
    const onOpenOAuthModal = vi.fn();
    const container = renderComponent(
      <EmptyConnectionsPlaceholder
        {...placeholderProps({
          providerId: "qoder",
          providerSupportsPat: true,
          isOAuth: false,
          openPrimaryAddFlow,
          openApiKeyAddFlow,
          onOpenOAuthModal,
        })}
      />
    );

    expectEntryInventory(container, ["Add PAT", "Experimental OAuth"]);
    expect(countByText(container, "Sign in (OAuth)")).toBe(0);
    expect(countByText(container, "Manual API key")).toBe(0);

    clickInAct(buttonByText(container, "Add PAT"));
    expect(openPrimaryAddFlow).toHaveBeenCalledTimes(1);
    expect(onOpenOAuthModal).not.toHaveBeenCalled();
    expect(openApiKeyAddFlow).not.toHaveBeenCalled();

    clickInAct(buttonByText(container, "Experimental OAuth"));
    expect(openPrimaryAddFlow).toHaveBeenCalledTimes(1);
    expect(onOpenOAuthModal).toHaveBeenCalledTimes(1);
    expect(openApiKeyAddFlow).not.toHaveBeenCalled();
  });

  it("OAuth-only providers (gemini): toolbar renders a single primary entry dispatching openPrimaryAddFlow", () => {
    const openPrimaryAddFlow = vi.fn();
    const openApiKeyAddFlow = vi.fn();
    const onOpenOAuthModal = vi.fn();
    const container = renderComponent(
      <ConnectionsHeaderToolbar
        {...toolbarProps({
          providerId: "gemini",
          isOAuth: true,
          providerSupportsPat: false,
          openPrimaryAddFlow,
          openApiKeyAddFlow,
          onOpenOAuthModal,
        })}
      />
    );

    // Complete inventory: exactly one connection-entry button; its label is the
    // icon span "add" + t("add") passthrough → normalized "addadd".
    const entries = entryButtons(container);
    expect(entries).toHaveLength(1);
    expect((entries[0].textContent || "").replace(/\s+/g, "")).toBe("addadd");
    expect(countByText(container, "Add PAT")).toBe(0);
    expect(countByText(container, "Sign in (OAuth)")).toBe(0);
    expect(countByText(container, "Manual API key")).toBe(0);
    expect(countByText(container, "Experimental OAuth")).toBe(0);

    clickInAct(entries[0]);
    expect(openPrimaryAddFlow).toHaveBeenCalledTimes(1);
    expect(openApiKeyAddFlow).not.toHaveBeenCalled();
    expect(onOpenOAuthModal).not.toHaveBeenCalled();
  });

  it("OAuth-only providers (gemini): placeholder renders a single primary entry dispatching openPrimaryAddFlow", () => {
    const openPrimaryAddFlow = vi.fn();
    const openApiKeyAddFlow = vi.fn();
    const onOpenOAuthModal = vi.fn();
    const container = renderComponent(
      <EmptyConnectionsPlaceholder
        {...placeholderProps({
          providerId: "gemini",
          providerSupportsPat: false,
          isOAuth: true,
          openPrimaryAddFlow,
          openApiKeyAddFlow,
          onOpenOAuthModal,
        })}
      />
    );

    // Complete inventory: exactly one connection-entry button ("add" icon +
    // t("addConnection") → normalized "addaddConnection").
    const entries = entryButtons(container);
    expect(entries).toHaveLength(1);
    expect((entries[0].textContent || "").replace(/\s+/g, "")).toBe("addaddConnection");
    expect(countByText(container, "Add PAT")).toBe(0);
    expect(countByText(container, "Sign in (OAuth)")).toBe(0);
    expect(countByText(container, "Manual API key")).toBe(0);
    expect(countByText(container, "Experimental OAuth")).toBe(0);

    clickInAct(entries[0]);
    expect(openPrimaryAddFlow).toHaveBeenCalledTimes(1);
    expect(openApiKeyAddFlow).not.toHaveBeenCalled();
    expect(onOpenOAuthModal).not.toHaveBeenCalled();
  });
});
