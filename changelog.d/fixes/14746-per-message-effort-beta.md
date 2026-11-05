A body carrying message-level `output_config` now gets the
`mid-conversation-output-config-2026-07-01` beta derived from its shape, and
`per-turn-control-2026-07-01` is forwarded when the client sent it. Without
these betas Anthropic rejects the field with
`400 messages.N.output_config: Extra inputs are not permitted`.
