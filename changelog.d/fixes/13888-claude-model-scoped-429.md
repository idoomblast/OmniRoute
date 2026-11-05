Claude usage parsing moves into `usage/claudeQuota.ts`: session, weekly, and
`weekly_scoped` limits are normalized separately, model-scoped windows land in
`modelQuotas` (display-only) instead of account-wide routing quotas, and
effort/context-decorated model ids match their scoped window.
