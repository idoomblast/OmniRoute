// Round-2 gate NB2: the display aliases must not raise an explicit output cap.
//
// The gate drove OpenAI translation through the real router and read the serialized
// envelope. It found `max_tokens: 16` + `reasoning_effort: "xhigh"` became 24,577 for
// `gemini-4-hydrogen`, `-extra`, and `-max`, because the translator tested the name
// the caller sent. Only a literal tier id (already canonical) stayed at 16.
//
// These tests therefore enter BEFORE translation and assert on the serialized wire
// envelope, which is the only place the defect was observable.
import test from "node:test";
import assert from "node:assert/strict";

import { openaiToAntigravityRequest } from "../../open-sse/translator/request/openai-to-gemini.ts";

type WireEnvelope = {
  model: string;
  request: { generationConfig: { maxOutputTokens?: number; thinkingConfig?: unknown } };
};

function serialize(model: string, reasoningEffort: string): WireEnvelope {
  const envelope = openaiToAntigravityRequest(
    model,
    {
      model,
      max_tokens: 16,
      reasoning_effort: reasoningEffort,
      messages: [{ role: "user", content: "hi" }],
    },
    false
  );
  return envelope as unknown as WireEnvelope;
}

const ALIASES = ["gemini-4-hydrogen", "gemini-4-hydrogen-extra", "gemini-4-hydrogen-max"];
const LITERALS = [
  "gemini-4-hydrogen-low",
  "gemini-4-hydrogen-medium",
  "gemini-4-hydrogen-high",
  "gemini-4-hydrogen-xhigh",
];

for (const model of [...ALIASES, ...LITERALS]) {
  test(`NB2 round2: ${model} keeps max_tokens 16 at xhigh effort`, () => {
    const wire = serialize(model, "xhigh");
    assert.equal(
      wire.request.generationConfig.maxOutputTokens,
      16,
      `${model} must not raise the caller's explicit cap for a budget the executor discards`
    );
  });
}

test("NB2 round2: a non-tier model still gets the cap bump (control)", () => {
  // The bump exists for a reason: a budget larger than the cap must widen it, or the
  // thinking budget is unusable. This control proves the exception stayed narrow.
  const wire = serialize("gemini-3.8-flash-high", "xhigh");
  assert.ok(
    (wire.request.generationConfig.maxOutputTokens ?? 0) > 16,
    "a non-tier model must still widen an explicit cap below its thinking budget"
  );
});

test("NB2 round2: the wire model keeps the caller's alias until the executor resolves it", () => {
  // Alias resolution is the EXECUTOR's job (antigravity.ts:286), not the translator's:
  // the serialized envelope carries the name the caller sent. What matters for NB2 is
  // that the cap decision used the RESOLVED id, so all three aliases still kept 16 —
  // asserted above. This test documents where resolution actually happens so a future
  // reader does not assume the translator rewrites ids.
  for (const alias of ALIASES) {
    assert.equal(serialize(alias, "xhigh").model, alias);
  }
  // And the tier ids the aliases point at are themselves canonical.
  for (const literal of LITERALS) {
    assert.equal(serialize(literal, "xhigh").model, literal);
  }
});
