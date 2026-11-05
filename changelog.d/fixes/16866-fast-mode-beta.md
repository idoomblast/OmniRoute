A body carrying the top-level `speed` parameter now gets the
`fast-mode-2026-02-01` beta derived from its shape, and the token is forwarded
when the client sent it. Without it Anthropic rejects Fast Mode requests with a
400 asking for that exact header.
