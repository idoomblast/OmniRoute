A request that explicitly asks for readable thinking (`thinking.display:
"summarized"`) no longer gets its thinking blocks blanked by
`redact-thinking-2026-02-12`, and `OMNIROUTE_REDACT_THINKING=false` now reaches
API-key Claude requests. The Claude OAuth fingerprint keeps the beta unless the
default-off `CLAUDE_OAUTH_SUMMARIZED_THINKING_UNREDACTED` feature flag is on.
