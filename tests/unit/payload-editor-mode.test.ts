import test from "node:test";
import assert from "node:assert/strict";
import {
  PAYLOAD_TREE_MAX_CHARS,
  createReadOnlyEditorOptions,
  isBlockedMutationShortcut,
  isValidJson,
  parsePayloadTreeMaxChars,
  resolvePayloadEditorMode,
} from "../../src/shared/utils/payloadEditorMode.ts";

test("isValidJson correctly identifies valid and invalid JSON strings", () => {
  assert.equal(isValidJson('{"hello":"world"}'), true);
  assert.equal(isValidJson("123"), true);
  assert.equal(isValidJson('"quoted"'), true);
  assert.equal(isValidJson("true"), true);
  assert.equal(isValidJson("null"), true);
  assert.equal(isValidJson("{broken:json}"), false);
  assert.equal(isValidJson("not json"), false);
  assert.equal(isValidJson(""), false);
  assert.equal(isValidJson(null), false);
  assert.equal(isValidJson(undefined), false);
});

test("resolvePayloadEditorMode selects tree mode for valid JSON at boundary 131,072 chars", () => {
  const prefix = '{"k":"';
  const suffix = '"}';
  const paddingLength = PAYLOAD_TREE_MAX_CHARS - prefix.length - suffix.length;
  const exactPayload = prefix + "a".repeat(paddingLength) + suffix;

  assert.equal(exactPayload.length, 131072);
  assert.equal(resolvePayloadEditorMode(exactPayload), "tree");
});

test("resolvePayloadEditorMode falls back to text mode at boundary 131,073 chars", () => {
  const prefix = '{"k":"';
  const suffix = '"}';
  const paddingLength = PAYLOAD_TREE_MAX_CHARS - prefix.length - suffix.length + 1;
  const overPayload = prefix + "a".repeat(paddingLength) + suffix;

  assert.equal(overPayload.length, 131073);
  assert.equal(resolvePayloadEditorMode(overPayload), "text");
});

test("resolvePayloadEditorMode falls back to text mode for invalid JSON", () => {
  assert.equal(resolvePayloadEditorMode("{not json}"), "text");
  assert.equal(resolvePayloadEditorMode("plain text error output"), "text");
  assert.equal(resolvePayloadEditorMode("[1, 2, broken]"), "text");
});

test("resolvePayloadEditorMode falls back to text mode for null, undefined, and non-string inputs", () => {
  assert.equal(resolvePayloadEditorMode(null), "text");
  assert.equal(resolvePayloadEditorMode(undefined), "text");
  assert.equal(resolvePayloadEditorMode(""), "text");
  assert.equal(resolvePayloadEditorMode(12345 as unknown as string), "text");
});

test("parsePayloadTreeMaxChars accepts non-negative integers and rejects invalid values", () => {
  assert.equal(parsePayloadTreeMaxChars(undefined), PAYLOAD_TREE_MAX_CHARS);
  assert.equal(parsePayloadTreeMaxChars(null), PAYLOAD_TREE_MAX_CHARS);
  assert.equal(parsePayloadTreeMaxChars(""), PAYLOAD_TREE_MAX_CHARS);
  assert.equal(parsePayloadTreeMaxChars("262144"), 262144);
  assert.equal(parsePayloadTreeMaxChars(" 2048 "), 2048);
  assert.equal(parsePayloadTreeMaxChars("0"), 0);
  assert.equal(parsePayloadTreeMaxChars("-1"), PAYLOAD_TREE_MAX_CHARS);
  assert.equal(parsePayloadTreeMaxChars("12.5"), PAYLOAD_TREE_MAX_CHARS);
  assert.equal(parsePayloadTreeMaxChars("not-a-number"), PAYLOAD_TREE_MAX_CHARS);
  assert.equal(parsePayloadTreeMaxChars("999999999999999999999"), PAYLOAD_TREE_MAX_CHARS);
});

test("resolvePayloadEditorMode honors a runtime threshold override", () => {
  const payload = '{"a":1}';
  assert.equal(resolvePayloadEditorMode(payload, payload.length), "tree");
  assert.equal(resolvePayloadEditorMode(payload, payload.length - 1), "text");
  assert.equal(resolvePayloadEditorMode(payload, 0), "text");
  assert.equal(resolvePayloadEditorMode(payload, 1_000_000), "tree");
  assert.equal(resolvePayloadEditorMode(payload, Number.NaN), "tree");
});

test("read-only editor options disable every JSONEditor mutation surface", () => {
  for (const mode of ["tree", "text"] as const) {
    const options = createReadOnlyEditorOptions(mode);
    assert.equal(options.mode, mode);
    assert.equal(options.history, false);
    assert.equal(options.mainMenuBar, false);
    assert.equal(options.enableSort, false);
    assert.equal(options.enableTransform, false);
    assert.equal(options.onEditable(), false);
    assert.deepEqual(options.onCreateMenu(), []);
  }
});

test("mutation hotkeys are blocked, navigation and copy shortcuts are not", () => {
  for (const key of ["d", "i", "m", "z", "y", "D", "I", "M", "Z", "Y"]) {
    assert.equal(isBlockedMutationShortcut({ key, ctrlKey: true }), true, `ctrl+${key}`);
    assert.equal(isBlockedMutationShortcut({ key, metaKey: true }), true, `meta+${key}`);
  }
  assert.equal(isBlockedMutationShortcut({ key: "Delete", ctrlKey: true }), true);
  assert.equal(isBlockedMutationShortcut({ key: "Insert", ctrlKey: true }), true);

  for (const key of ["c", "f", "a", "v", "x", "ArrowDown"]) {
    assert.equal(isBlockedMutationShortcut({ key, ctrlKey: true }), false, `ctrl+${key}`);
  }
  assert.equal(isBlockedMutationShortcut({ key: "d" }), false);
  assert.equal(isBlockedMutationShortcut({ key: "Delete" }), false);

  for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
    assert.equal(isBlockedMutationShortcut({ key, altKey: true, shiftKey: true }), true);
    assert.equal(isBlockedMutationShortcut({ key, altKey: true }), false);
  }
});
