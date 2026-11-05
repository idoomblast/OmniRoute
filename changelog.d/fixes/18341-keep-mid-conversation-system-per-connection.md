The anthropic-compatible mid-conversation system passthrough is now a
per-connection opt-in (`providerSpecificData.keepMidConversationSystem`,
default off) instead of a global feature flag, exposed in the connection edit
modal. Whether a relay accepts `role: "system"` inside `messages[]` is a
property of that relay, not of the client, so the operator decides per
connection. The client's own mid-conversation-system beta is still forwarded
when present and never invented.
