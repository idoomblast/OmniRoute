Claude usage readings run through the proxy assigned to the connection via the
shared `connectionProxyFetch` helper; a proxied failure reports the missing
reading instead of silently retrying outside the proxy. The bootstrap read stays
best-effort and direct.
