Claude Code: dashboard control for the advertised CLI client version (#14817)

The provider detail page now exposes the Claude Code client version OmniRoute
advertises on Anthropic-bound requests. The value is persisted in settings,
validated before it reaches the wire, hydrated on boot and on every settings
write, and reports which layer won (dashboard override, environment variable,
auto-discovered release, or captured pin). Only the Claude kind is exposed in
this backport.
