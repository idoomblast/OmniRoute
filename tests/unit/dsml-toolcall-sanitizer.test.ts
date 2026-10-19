import test from "node:test";
import assert from "node:assert/strict";

/* eslint-disable @typescript-eslint/no-explicit-any */
const { parseDsmlToolCalls } = await import("../../open-sse/utils/dsmlToolCall.ts");
const { sanitizeOpenAIResponse } = await import("../../open-sse/handlers/responseSanitizer.ts");

const DSML_SINGLE = `Before text.
<｜DSML｜tool_calls>
<｜DSML｜invoke name="terminal">
<｜DSML｜parameter name="command">ls /tmp</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜tool_calls>
After text.`;

const DSML_MULTI = `<｜DSML｜tool_calls>
<｜DSML｜invoke name="write_file">
<｜DSML｜parameter name="path">/tmp/a.txt</｜DSML｜parameter>
<｜DSML｜parameter name="content">hello world</｜DSML｜parameter>
</｜DSML｜invoke>
<｜DSML｜invoke name="read_file">
<｜DSML｜parameter name="path">/tmp/b.txt</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜tool_calls>`;

test("parseDsmlToolCalls parses a complete single-invoke block", () => {
  const calls = parseDsmlToolCalls(DSML_SINGLE);
  assert.ok(calls, "should parse");
  assert.equal(calls!.length, 1);
  assert.equal(calls![0].name, "terminal");
  assert.deepEqual(calls![0].args, { command: "ls /tmp" });
});

test("parseDsmlToolCalls parses multiple invokes in one block", () => {
  const calls = parseDsmlToolCalls(DSML_MULTI);
  assert.ok(calls);
  assert.equal(calls!.length, 2);
  assert.equal(calls![0].name, "write_file");
  assert.equal(calls![1].name, "read_file");
  assert.deepEqual(calls![0].args, { path: "/tmp/a.txt", content: "hello world" });
  assert.deepEqual(calls![1].args, { path: "/tmp/b.txt" });
});

test("parseDsmlToolCalls JSON-decodes parameter values that look like JSON", () => {
  const content = `<｜DSML｜tool_calls>
<｜DSML｜invoke name="patch">
<｜DSML｜parameter name="args">{"path": "a.ts", "old": "x", "new": "y"}</｜DSML｜parameter>
<｜DSML｜parameter name="count">3</｜DSML｜parameter>
<｜DSML｜parameter name="flag">true</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜tool_calls>`;
  const calls = parseDsmlToolCalls(content);
  assert.ok(calls);
  assert.deepEqual(calls![0].args, {
    args: { path: "a.ts", old: "x", new: "y" },
    count: 3,
    flag: true,
  });
});

test("parseDsmlToolCalls strips zero-width characters before parsing", () => {
  const content = `<\u200B｜DSML｜tool_calls>\u200B
<｜DSML｜invoke name="terminal">
<｜DSML｜parameter name="command">echo\u200B hi</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜tool_calls>`;
  const calls = parseDsmlToolCalls(content);
  assert.ok(calls);
  assert.deepEqual(calls![0].args, { command: "echo hi" });
});

test("parseDsmlToolCalls handles parameter values containing quotes", () => {
  const content = `<｜DSML｜tool_calls>
<｜DSML｜invoke name="terminal">
<｜DSML｜parameter name="command">grep "pattern" file.txt</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜tool_calls>`;
  const calls = parseDsmlToolCalls(content);
  assert.ok(calls);
  assert.deepEqual(calls![0].args, { command: 'grep "pattern" file.txt' });
});

test("parseDsmlToolCalls returns null for incomplete/malformed DSML", () => {
  // Unclosed tool_calls block
  assert.equal(parseDsmlToolCalls('<｜DSML｜tool_calls><｜DSML｜invoke name="a">'), null);
  // Opening tag only
  assert.equal(parseDsmlToolCalls("<｜DSML｜tool_calls>"), null);
  // No invoke inside block
  assert.equal(parseDsmlToolCalls("<｜DSML｜tool_calls>nothing</｜DSML｜tool_calls>"), null);
  // Empty content / non-string
  assert.equal(parseDsmlToolCalls(""), null);
  assert.equal(parseDsmlToolCalls(null), null);
  assert.equal(parseDsmlToolCalls(12345), null);
  // Regular XML look-alike (plain vertical bars, not fullwidth U+FF5C) is ignored
  assert.equal(parseDsmlToolCalls("<|DSML|tool_calls>x</|DSML|tool_calls>"), null);
});

test("parseDsmlToolCalls ignores DSML-looking content outside tool_calls blocks", () => {
  const content = `The model discussed <｜DSML｜invoke name="fake"> but never emitted a block.`;
  assert.equal(parseDsmlToolCalls(content), null);
});

test("sanitizeOpenAIResponse converts DSML tool calls only when parseDsmlToolCalls is enabled", () => {
  const body = {
    id: "chatcmpl_dsml",
    object: "chat.completion",
    created: 123,
    model: "deepseek-v4.1-flash",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: DSML_SINGLE,
        },
        finish_reason: "stop",
      },
    ],
  };

  // Flag OFF: DSML passes through as plain content (current behavior — no crash).
  const off = sanitizeOpenAIResponse(body, { parseDsmlToolCalls: false });
  assert.equal((off as Record<string, any>).choices[0].message.content, DSML_SINGLE);
  assert.equal((off as Record<string, any>).choices[0].message.tool_calls, undefined);

  // Flag ON: DSML converted to standard tool_calls.
  const on = sanitizeOpenAIResponse(body, { parseDsmlToolCalls: true }) as Record<string, any>;
  const msg = on.choices[0].message;
  // Prose surrounding the DSML block is preserved as remainder (R2 fix: never
  // silently discard prose that happens to surround a converted call).
  assert.equal(msg.content, "Before text.\n\nAfter text.");
  assert.equal(msg.tool_calls.length, 1);
  assert.equal(msg.tool_calls[0].type, "function");
  assert.equal(msg.tool_calls[0].function.name, "terminal");
  assert.deepEqual(JSON.parse(msg.tool_calls[0].function.arguments), { command: "ls /tmp" });
  assert.equal(on.choices[0].finish_reason, "tool_calls");
});

test("sanitizeOpenAIResponse does not touch DSML when native tool_calls already present", () => {
  const body = {
    id: "chatcmpl_native",
    object: "chat.completion",
    created: 123,
    model: "deepseek-v4.1-flash",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: DSML_SINGLE,
          tool_calls: [
            {
              id: "call_native_1",
              type: "function",
              function: { name: "terminal", arguments: '{"command":"pwd"}' },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  };

  const out = sanitizeOpenAIResponse(body, { parseDsmlToolCalls: true }) as Record<string, any>;
  const msg = out.choices[0].message;
  // Native tool_calls preserved; content NOT nulled (native path untouched).
  assert.equal(msg.tool_calls.length, 1);
  assert.equal(msg.tool_calls[0].id, "call_native_1");
  assert.equal(msg.content, DSML_SINGLE);
});

test("sanitizeOpenAIResponse DSML path leaves non-DSML content unchanged even with flag on", () => {
  const body = {
    id: "chatcmpl_plain",
    object: "chat.completion",
    created: 123,
    model: "deepseek-v4.1-flash",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "Just a normal answer." },
        finish_reason: "stop",
      },
    ],
  };
  const out = sanitizeOpenAIResponse(body, { parseDsmlToolCalls: true }) as Record<string, any>;
  assert.equal(out.choices[0].message.content, "Just a normal answer.");
  assert.equal(out.choices[0].message.tool_calls, undefined);
});

test("sanitizeOpenAIResponse converts multiple DSML invokes to multiple tool_calls entries", () => {
  const body = {
    id: "chatcmpl_multi",
    object: "chat.completion",
    created: 123,
    model: "deepseek-v4.1-flash",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: DSML_MULTI },
        finish_reason: "stop",
      },
    ],
  };
  const out = sanitizeOpenAIResponse(body, { parseDsmlToolCalls: true }) as Record<string, any>;
  const calls = out.choices[0].message.tool_calls;
  assert.equal(calls.length, 2);
  assert.equal(calls[0].function.name, "write_file");
  assert.equal(calls[1].function.name, "read_file");
});

test("parseDsmlToolCalls rejects a malformed parameter (unclosed parameter inside closed invoke)", () => {
  const s =
    '<｜DSML｜tool_calls><｜DSML｜invoke name="terminal"><｜DSML｜parameter name="command">partial</｜DSML｜invoke></｜DSML｜tool_calls>';
  assert.equal(parseDsmlToolCalls(s), null);
});

test("parseDsmlToolCalls preserves indentation and newlines in plain string values", () => {
  const calls = parseDsmlToolCalls(
    '<｜DSML｜tool_calls><｜DSML｜invoke name="write_file"><｜DSML｜parameter name="content">  indented\nline</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>'
  );
  assert.ok(calls);
  assert.equal(calls![0].args.content, "  indented\nline");
});

test("parseDsmlToolCalls decodes quoted JSON string values", () => {
  const calls = parseDsmlToolCalls(
    '<｜DSML｜tool_calls><｜DSML｜invoke name="write_file"><｜DSML｜parameter name="content">"hello\\nworld"</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>'
  );
  assert.ok(calls);
  assert.equal(calls![0].args.content, "hello\nworld");
});

test("parseDsmlToolCalls decodes exponent number values", () => {
  const calls = parseDsmlToolCalls(
    '<｜DSML｜tool_calls><｜DSML｜invoke name="f"><｜DSML｜parameter name="count">1e3</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>'
  );
  assert.ok(calls);
  assert.equal(calls![0].args.count, 1000);
});

test("parseDsmlToolCalls stores __proto__ parameter as an own argument (no prototype pollution)", () => {
  const calls = parseDsmlToolCalls(
    '<｜DSML｜tool_calls><｜DSML｜invoke name="f"><｜DSML｜parameter name="__proto__">{"polluted":true}</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>'
  );
  assert.ok(calls);
  assert.equal(Object.hasOwn(calls![0].args, "__proto__"), true);
});

test("parseDsmlToolCalls handles a 130k-invoke block without stack overflow", () => {
  const s =
    "<｜DSML｜tool_calls>" +
    '<｜DSML｜invoke name="a"></｜DSML｜invoke>'.repeat(130000) +
    "</｜DSML｜tool_calls>";
  const calls = parseDsmlToolCalls(s);
  assert.ok(calls);
  assert.equal(calls!.length, 130000);
});

test("sanitizeOpenAIResponse malformed-parameter DSML falls back losslessly (non-streaming)", () => {
  const s =
    '<｜DSML｜tool_calls><｜DSML｜invoke name="terminal"><｜DSML｜parameter name="command">partial</｜DSML｜invoke></｜DSML｜tool_calls>';
  const out = sanitizeOpenAIResponse(
    {
      id: "chatcmpl_malformed",
      object: "chat.completion",
      created: 1,
      model: "deepseek-v4.1-flash",
      choices: [{ index: 0, message: { role: "assistant", content: s }, finish_reason: "stop" }],
    },
    { parseDsmlToolCalls: true }
  ) as Record<string, any>;
  assert.equal(out.choices[0].message.content, s);
  assert.equal(out.choices[0].message.tool_calls, undefined);
});
