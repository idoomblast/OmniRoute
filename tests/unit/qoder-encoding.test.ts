import { test } from "node:test";
import assert from "node:assert/strict";
import { qoderEncodeBody } from "../../open-sse/shared/qoder/encoding.ts";

test("qoderEncodeBody: round-trip encode produces non-empty output for simple input", () => {
  const input = "hello world";
  const encoded = qoderEncodeBody(input);
  assert.ok(typeof encoded === "string");
  assert.ok(encoded.length > 0);
  // The encoded output should differ from the plain base64 of the input
  assert.notEqual(encoded, Buffer.from(input).toString("base64"));
});

test("qoderEncodeBody: accepts Buffer input", () => {
  const buf = Buffer.from("test payload", "utf8");
  const encoded = qoderEncodeBody(buf);
  assert.ok(typeof encoded === "string");
  assert.ok(encoded.length > 0);
});

test("qoderEncodeBody: accepts Uint8Array input", () => {
  const arr = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello"
  const encoded = qoderEncodeBody(arr);
  assert.ok(typeof encoded === "string");
  assert.ok(encoded.length > 0);
});

test("qoderEncodeBody: empty string produces empty-ish output", () => {
  const encoded = qoderEncodeBody("");
  // base64 of "" is "", rearrangement of "" is "", so output should be ""
  assert.equal(encoded, "");
});

test("qoderEncodeBody: output uses custom alphabet (not standard base64)", () => {
  const input = "ABCDEFGH"; // 8 bytes → base64 "QUJDREVGR0g=" (12 chars)
  const encoded = qoderEncodeBody(input);
  const stdB64 = Buffer.from(input).toString("base64");
  // The encoded string should not be identical to standard base64
  assert.notEqual(encoded, stdB64);
  // And should not contain only standard base64 characters
  const stdAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const hasCustomChar = [...encoded].some((c) => !stdAlphabet.includes(c) && c !== "=");
  assert.ok(hasCustomChar, "encoded output should contain custom alphabet characters");
});

test("qoderEncodeBody: deterministic — same input always produces same output", () => {
  const input = "deterministic test input 12345";
  const a = qoderEncodeBody(input);
  const b = qoderEncodeBody(input);
  assert.equal(a, b);
});

test("qoderEncodeBody: handles non-ASCII (UTF-8) input", () => {
  const input = "héllo wörld 日本語";
  const encoded = qoderEncodeBody(input);
  assert.ok(typeof encoded === "string");
  assert.ok(encoded.length > 0);
  // Should differ from standard base64
  assert.notEqual(encoded, Buffer.from(input).toString("base64"));
});

test("qoderEncodeBody: large input produces proportionally large output", () => {
  const small = qoderEncodeBody("a");
  const large = qoderEncodeBody("a".repeat(1000));
  assert.ok(large.length > small.length);
  // base64 inflates by ~4/3, so large should be roughly 1300+ chars
  assert.ok(large.length > 1000);
});

test("qoderEncodeBody: padding character '=' mapped to '$'", () => {
  // Input that produces base64 with padding: "abc" → "YWJj" (no pad), "ab" → "YWI=" (1 pad)
  const input = "ab"; // base64 = "YWI=" → has 1 padding '='
  const encoded = qoderEncodeBody(input);
  // The '=' should have been substituted; encoded should not contain '='
  // (it's mapped to '$' in the custom alphabet)
  assert.ok(!encoded.includes("="), "padding '=' should be substituted");
});
