Claude-native handoffs now append their note to the top-level `system` field
instead of prepending a `role: "system"` message, which Anthropic rejects at
`messages[0]`. A final `finalizeClaudeBodyConstraints` pass hoists leading
system messages, relocates directive-only messages, and enforces the
thinking/temperature invariant immediately before serialization.
