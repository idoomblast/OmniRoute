restoreClaudeToolName keeps canonical casing for known Claude Code tools when
the upstream echoes the exact name the request declared, while still honouring
request-side aliases (custom and server tools) over the static table.
