`effort-2025-11-24` no longer implies `advanced-tool-use-2025-11-20`. Claude Code
sends effort on every request and never sends ATU, so the old proxy gate
force-injected a heavy-agent beta the client never negotiated. Effort itself is
now on the client allowlist so it survives the merge.
