import assert from "node:assert/strict";
import test from "node:test";
import { clip, errorWindow, MAX_OUTPUT_LINES, redact, tailLines } from "../src/text.js";

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

const noisyLog = (errorAt: number, total = 400): string =>
  Array.from({ length: total }, (_, index) =>
    index === errorAt ? "AssertionError: expected 3 to be 4" : "step " + String(index) + ": ok",
  ).join("\n");

test("errorWindow keeps the error that a tail would have dropped", () => {
  const log = noisyLog(150);
  const tail = tailLines(log, 40);
  const window = errorWindow(log, 40);
  assert.equal(tail.includes("AssertionError"), false);
  assert.match(window, /AssertionError: expected 3 to be 4/);
  assert.match(window, /…\(145 earlier lines omitted\)/);
  assert.match(window, /…\(215 later lines omitted\)/);
  assert.equal(window.split("\n").length, 42);
});

test("errorWindow keeps five lines of context before the marker", () => {
  const window = errorWindow(noisyLog(150), 40);
  assert.match(window, /step 145: ok/);
  assert.equal(/step 144: ok/.test(window), false);
});

test("errorWindow degrades to a tail when nothing looks like a failure", () => {
  const quiet = Array.from({ length: 100 }, (_, index) => "line " + String(index)).join("\n");
  assert.equal(errorWindow(quiet, 10), tailLines(quiet, 10));
  assert.match(errorWindow(quiet, 10), /…\(90 earlier lines omitted\)/);
});

test("errorWindow returns a short log untouched and normalises CRLF", () => {
  assert.equal(errorWindow("a\r\nb\r\n", 40), "a\nb");
});

test("errorWindow starts at the marker when it is near the top", () => {
  const window = errorWindow("AssertionError: x\n" + "noise\n".repeat(100), 40);
  assert.match(window, /^AssertionError: x\n/);
  assert.match(window, /…\(66 later lines omitted\)$/);
});

test("redact removes bearer headers and access-token URLs", () => {
  const out = redact("Authorization: Bearer abcdefghijklmnop1234 and x-access-token:secretvalue@github.com");
  assert.ok(!out.includes("abcdefghijklmnop1234"));
  assert.ok(!out.includes("secretvalue"));
});
