Claude OAuth usage polling now coalesces concurrent reads, reuses a success for
65s, honors `Retry-After` / `anthropic-ratelimit-*-reset` on 429 (clamped
3-30 min), serves the last known quota flagged `_stale` instead of hitting the
legacy endpoints, and reports 401 as expired authentication.
