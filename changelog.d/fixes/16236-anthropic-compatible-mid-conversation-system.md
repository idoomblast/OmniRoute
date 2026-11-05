Plain `anthropic-compatible-*` relays can now keep mid-conversation
`role: "system"` turns inside `messages[]` instead of hoisting them into the
top-level `system` parameter, so the cached prompt prefix stays stable across
turns. The in-place shape is opt-in via
`ANTHROPIC_COMPATIBLE_MID_CONVERSATION_SYSTEM` (default off) and only applies
when the client itself negotiated the `mid-conversation-system-2026-04-07`
beta, which is forwarded as-is.
