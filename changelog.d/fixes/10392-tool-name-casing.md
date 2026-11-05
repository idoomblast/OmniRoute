Claude-format response translators restore the caller's request-declared tool
name instead of relying on a static TitleCase table, so a lowercase echo from
an OpenAI- or Gemini-shaped upstream no longer reaches Claude Code as an
unknown tool.
