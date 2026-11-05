On the native Claude OAuth path, a cache_control block without an explicit TTL
now defaults to 1h instead of Anthropic's silent 5-minute fallback, so pauses
between turns no longer force a full prefix rewrite. Explicit client TTLs are
left untouched.
