Plain `anthropic-compatible-*` relays can now keep mid-conversation
`role: "system"` turns inside `messages[]` instead of hoisting them into the
top-level `system` parameter, so the cached prompt prefix stays stable across
turns. The in-place shape is a per-connection opt-in via
`providerSpecificData.keepMidConversationSystem` (default off): whether a relay
accepts `role: "system"` inside `messages[]` is a property of that relay, not of
the client. A client that does send the `mid-conversation-system-2026-04-07`
beta still has it forwarded as-is; OmniRoute never invents it.
