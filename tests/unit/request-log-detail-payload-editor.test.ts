import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const { default: RequestLoggerDetail } =
  await import("../../src/shared/components/RequestLoggerDetail.tsx");

test("request log detail renders payload sections with PayloadJsonEditor and no pre block", () => {
  const log = {
    id: "log-payload-test-1",
    status: 200,
    method: "POST",
    path: "/v1/chat/completions",
    timestamp: "2026-04-09T21:27:08.000Z",
    duration: 120,
    provider: "openai",
    sourceFormat: "openai-chat",
    model: "gpt-4o",
    tokens: {
      in: 15,
      out: 25,
      cacheRead: null,
      cacheWrite: null,
      reasoning: null,
    },
  };

  const detail = {
    ...log,
    pipelinePayloads: {
      clientRawRequest: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello world" }],
      },
    },
  };

  const RequestLoggerDetailComponent = RequestLoggerDetail as React.ComponentType<{
    log: Record<string, unknown>;
    detail: Record<string, unknown>;
    loading: boolean;
    onClose: () => void;
    onCopy: () => Promise<boolean>;
  }>;

  const html = renderToStaticMarkup(
    React.createElement(RequestLoggerDetailComponent, {
      log,
      detail,
      loading: false,
      onClose: () => {},
      onCopy: async () => true,
    })
  );

  // Section title is present
  assert.notEqual(
    html.indexOf("Client Raw Request"),
    -1,
    "Payload section title 'Client Raw Request' should be present"
  );

  // Copy button is present
  assert.notEqual(
    html.indexOf('aria-label="Copy Client Raw Request"'),
    -1,
    "Copy button with aria-label should be present"
  );

  // Collapse button aria-label is present
  assert.notEqual(
    html.indexOf('aria-label="Collapse Client Raw Request"'),
    -1,
    "Collapse button with aria-label should be present"
  );

  // Payload editor element is present (the dynamic loading wrapper during SSR)
  assert.notEqual(
    html.indexOf('data-testid="payload-json-editor"'),
    -1,
    "PayloadJsonEditor placeholder with data-testid='payload-json-editor' should be present"
  );

  // No <pre> tag renders in the payload fixture (since there are no stream chunks)
  assert.equal(html.includes("<pre"), false, "No <pre> element should render for payload sections");
});
