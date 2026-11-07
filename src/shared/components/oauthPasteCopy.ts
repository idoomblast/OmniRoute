/** Copy for the token-paste tab, kept out of OAuthModal's frozen line budget. */

export function pasteTabLabel(provider: string): string {
  if (provider === "grok-cli") return "Import auth.json";
  if (provider === "claude") return "Setup Token";
  return "Paste API Key";
}

export function pasteHint(provider: string): string {
  if (provider === "windsurf") {
    return 'In the Windsurf / VS Code IDE, run the "Windsurf: Provide Auth Token" command from the command palette (or click the Jupyter "Get Windsurf Authentication Token" button), then copy the shown token and paste it below. Opening windsurf.com/show-auth-token directly only shows a "Redirecting" page — the IDE must initiate the flow.';
  }
  if (provider === "grok-cli") {
    return 'Paste the FULL contents of ~/.grok/auth.json (not just the JWT "key" field). A bare JWT has no refresh_token, so the connection dies after expiry (#7610). Prefer the dedicated Import auth.json modal when available.';
  }
  if (provider === "claude") {
    return "Run `claude setup-token` in a terminal, then paste the sk-ant-oat token below. It is verified with Anthropic before it is saved.";
  }
  return 'Provide your WINDSURF_API_KEY (obtained via `devin auth login`, or via the Windsurf IDE "Windsurf: Provide Auth Token" command).';
}

export function pastePlaceholder(provider: string): string {
  return provider === "claude" ? "sk-ant-oat..." : "ws-...";
}
