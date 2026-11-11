import assert from "node:assert/strict";
import test from "node:test";
import { clip, MAX_OUTPUT_LINES, redact } from "../src/text.js";

test("clip leaves short text untouched", () => {
  const input = "abc\ndef";
  assert.equal(clip(input), input);
});

test("clip normalises CRLF so line counts are predictable", () => {
  assert.equal(clip("a\r\nb\r\nc"), "a\nb\nc");
});

test("clip truncates by line budget and explains how to narrow", () => {
  const input = Array.from({ length: MAX_OUTPUT_LINES + 50 }, (_, i) => "line " + i).join("\n");
  const out = clip(input);
  const lines = out.split("\n");
  assert.equal(lines.length, MAX_OUTPUT_LINES + 1);
  assert.match(lines[lines.length - 1] ?? "", /truncated \(50 more lines; narrow with path= or max_lines=\)/);
});

test("clip truncates by byte budget", () => {
  const out = clip("x".repeat(1000), { maxBytes: 100, maxLines: 1000 });
  assert.ok(Buffer.byteLength(out, "utf8") <= 100);
  assert.match(out, /truncated/);
});

test("clip honours a custom hint", () => {
  const out = clip("a\nb\nc", { maxLines: 2, hint: "pass a smaller range" });
  assert.match(out, /pass a smaller range/);
});

test("redact removes classic and fine-grained GitHub tokens", () => {
  const input = "a ghp_" + "a".repeat(36) + " b github_pat_" + "b".repeat(30) + " c";
  const out = redact(input);
  assert.ok(!out.includes("ghp_aaaaaaaa"));
  assert.ok(!out.includes("github_pat_bbbb"));
  assert.match(out, /ghp_\*\*\*redacted\*\*\*/);
});

test("redact removes bearer headers and access-token URLs", () => {
  const out = redact("Authorization: Bearer abcdefghijklmnop1234 and x-access-token:secretvalue@github.com");
  assert.ok(!out.includes("abcdefghijklmnop1234"));
  assert.ok(!out.includes("secretvalue"));
});
