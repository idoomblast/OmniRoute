import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const { default: PayloadJsonEditorFallback } =
  await import("../../src/shared/components/PayloadJsonEditorFallback.tsx");

test("payload fallback renders escaped raw text, a reason, and a retry control", () => {
  const marker = 'sensitive-marker</pre><script>alert("x")</script>';
  const html = renderToStaticMarkup(
    React.createElement(PayloadJsonEditorFallback, {
      text: `{"malformed": "${marker}"}`,
      reason: "Viewer unavailable",
      onRetry: () => {},
    })
  );

  assert.notEqual(html.indexOf("Viewer unavailable"), -1);
  assert.notEqual(html.indexOf(">Retry<"), -1);
  assert.notEqual(html.indexOf("payload-json-editor-fallback"), -1);
  // Payload text is escaped, never interpreted as markup.
  assert.equal(html.includes("<script>"), false);
  assert.equal(html.includes("</pre><script>"), false);
  assert.notEqual(html.indexOf("&lt;script&gt;"), -1);
  assert.notEqual(html.indexOf("sensitive-marker"), -1);
});
