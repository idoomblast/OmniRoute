Hoisting a mid-conversation system/developer message no longer destroys the
client's prompt-cache layout. The cache_control marker moves to the nearest
preceding block that can carry a breakpoint, and substituted file/tool_result
blocks inherit the marker instead of silently dropping it.
