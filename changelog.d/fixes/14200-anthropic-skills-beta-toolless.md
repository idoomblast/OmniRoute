The `skills-2025-10-02` beta is now emitted only when the request actually
declares a `code_execution` tool, and stripped again if transformation removes
it. Tool-less requests no longer 400 with "Skills beta requires the
code_execution tool", which fired for every Claude Code request because the
static beta set shipped skills unconditionally.
