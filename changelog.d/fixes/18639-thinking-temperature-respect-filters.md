Thinking temperature is pinned to 1 only when the request actually carries a
sampling parameter. A body with neither `temperature` nor `top_p` now stays on
Anthropic's unset branch, so a param filter that removed temperature no longer
has it re-added and temperature-retired models stop returning 400.
