/**
 * Pricing data — shared per-MTok tier constants (god-file decomposition). Pure data; merged by the barrel.
 */
// OpenAI API Standard; Codex Standard has the same dollar-equivalent rates.
// https://openai.com/index/gpt-6-astra/
export const GPT_6_ASTRA_PRICING = {
  input: 10.0,
  output: 50.0,
  cached: 1.0,
  reasoning: 50.0,
  cache_creation: 12.5,
};

// GPT-6 Sol: Codex Standard 50 / 5 / 250 credits per MTok at 25 credits/USD.
// Shared by the Codex and OpenAI alias rows until OpenAI publishes a distinct
// public-API rate.
export const GPT_6_SOL_PRICING = {
  input: 2.0,
  output: 10.0,
  cached: 0.2,
  reasoning: 10.0,
  cache_creation: 2.5,
};

// GPT-6 Luna: Codex Standard 2.5 / 0.25 / 12.5 credits per MTok.
export const GPT_6_LUNA_PRICING = {
  input: 0.1,
  output: 0.5,
  cached: 0.01,
  reasoning: 0.5,
  cache_creation: 0.125,
};

export const GPT_5_3_CODEX_PRICING = {
  input: 5.0,
  output: 20.0,
  cached: 2.5,
  reasoning: 30.0,
  cache_creation: 5.0,
};

export const GPT_5_5_PRICING = {
  input: 5.0,
  output: 30.0,
  cached: 0.5,
  reasoning: 30.0,
  cache_creation: 5.0,
};

export const GPT_5_6_SOL_PRICING = {
  input: 5.0,
  output: 30.0,
  cached: 0.5,
  reasoning: 30.0,
  cache_creation: 6.25,
};

export const GPT_5_6_TERRA_PRICING = {
  input: 2.5,
  output: 15.0,
  cached: 0.25,
  reasoning: 15.0,
  cache_creation: 3.125,
};

export const GPT_5_6_LUNA_PRICING = {
  input: 1.0,
  output: 6.0,
  cached: 0.1,
  reasoning: 6.0,
  cache_creation: 1.25,
};

export const CLAUDE_FABLE_5_1_PRICING = {
  input: 10.0,
  output: 50.0,
  cached: 0.25,
  reasoning: 50.0,
  cache_creation: 12.5,
};

export const CLAUDE_FABLE_5_PRICING = {
  input: 15.0,
  output: 75.0,
  cached: 7.5,
  reasoning: 112.5,
  cache_creation: 15.0,
};

export const CLAUDE_OPUS_5_5_PRICING = {
  input: 4.0,
  output: 20.0,
  cached: 0.2,
  reasoning: 20.0,
  cache_creation: 5.0,
};

export const CLAUDE_OPUS_5_PRICING = {
  input: 5.0,
  output: 25.0,
  cached: 0.5,
  reasoning: 25.0,
  cache_creation: 6.25,
};

export const CLAUDE_OPUS_4_PRICING = {
  input: 15.0,
  output: 75.0,
  cached: 7.5,
  reasoning: 112.5,
  cache_creation: 15.0,
};

export const CLAUDE_SONNET_4_PRICING = {
  input: 3.0,
  output: 15.0,
  cached: 1.5,
  reasoning: 15.0,
  cache_creation: 3.0,
};

export const CLAUDE_OPUS_46_PRICING = {
  input: 5.0,
  output: 25.0,
  cached: 2.5,
  reasoning: 37.5,
  cache_creation: 5.0,
};

export const CLAUDE_SONNET_46_PRICING = {
  input: 3.0,
  output: 15.0,
  cached: 1.5,
  reasoning: 22.5,
  cache_creation: 3.0,
};

// Claude Sonnet 5 / 5.5 — platform.claude.com, 2026-09-28.
// Published: input $2, output $10, cache reads $0.20, 5-minute cache
// writes $2.50 (prompt-caching docs). reasoning is not published as its
// own rate; $10 follows the output price.
export const CLAUDE_SONNET_5_PRICING = {
  input: 2.0,
  output: 10.0,
  cached: 0.2,
  reasoning: 10.0,
  cache_creation: 2.5,
};

// Claude Haiku 5 / 5.5 — length-tiered pricing, source:
// https://platform.claude.com/docs/en/about-claude/pricing
// Prompts up to 100k tokens: $0.10 in / $0.50 out / $0.01 cache hit / $0.125 5m cache write.
// Prompts over 100k tokens (cache reads/writes count): $0.50 / $2.50 / $0.05 / $0.625,
// applied to the whole request via the `long_context` tier.
export const CLAUDE_HAIKU_5_PRICING = {
  input: 0.1,
  output: 0.5,
  cached: 0.01,
  reasoning: 0.5,
  cache_creation: 0.125,
  long_context: {
    threshold: 100_000,
    input: 0.5,
    output: 2.5,
    cached: 0.05,
    reasoning: 2.5,
    cache_creation: 0.625,
  },
};

export const GLM_PRICING = {
  "glm-5.2": {
    input: 1.2,
    output: 5,
    cached: 0.3,
    reasoning: 5,
    cache_creation: 1.2,
  },
  "glm-5.2-high": {
    input: 1.2,
    output: 5,
    cached: 0.3,
    reasoning: 5,
    cache_creation: 1.2,
  },
  "glm-5.2-max": {
    input: 1.2,
    output: 5,
    cached: 0.3,
    reasoning: 5,
    cache_creation: 1.2,
  },
  "glm-5.1": {
    input: 1.2,
    output: 5,
    cached: 0.3,
    reasoning: 5,
    cache_creation: 1.2,
  },
  "glm-5": {
    input: 1.0,
    output: 3.2,
    cached: 0.2,
    reasoning: 4.8,
    cache_creation: 1.0,
  },
  "glm-5-turbo": {
    input: 1.2,
    output: 4.0,
    cached: 0.24,
    reasoning: 4.0,
    cache_creation: 1.2,
  },
  "glm-4.7-flash": {
    input: 0,
    output: 0,
    cached: 0,
    reasoning: 0,
    cache_creation: 0,
  },
  "glm-4.7": {
    input: 0.6,
    output: 2.2,
    cached: 0.11,
    reasoning: 2.2,
    cache_creation: 0.6,
  },
  "glm-4.6": {
    input: 0.6,
    output: 2.2,
    cached: 0.11,
    reasoning: 2.2,
    cache_creation: 0.6,
  },
  "glm-4.6v": {
    input: 0.3,
    output: 0.9,
    cached: 0.05,
    reasoning: 0.9,
    cache_creation: 0.3,
  },
  "glm-4.5v": {
    input: 0.6,
    output: 1.8,
    cached: 0.11,
    reasoning: 1.8,
    cache_creation: 0.6,
  },
  "glm-4.5": {
    input: 0.6,
    output: 2.2,
    cached: 0.11,
    reasoning: 2.2,
    cache_creation: 0.6,
  },
  "glm-4.5-air": {
    input: 0.2,
    output: 1.1,
    cached: 0.03,
    reasoning: 1.1,
    cache_creation: 0.2,
  },
};
