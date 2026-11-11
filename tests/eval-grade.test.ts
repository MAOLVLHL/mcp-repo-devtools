import assert from "node:assert/strict";
import test from "node:test";

import type { AgentRun } from "../src/agent/loop.js";
import type { Fixture } from "../src/eval/fixture.js";
import { gradeRun, introducedBySection } from "../src/eval/grade.js";

const fixture: Fixture = {
  id: "demo",
  symptom: "a test fails",
  expected_commit: 2,
  commits: [
    { message: "feat: first", files: { "a.txt": "one\n" } },
    { message: "refactor: break it", files: { "a.txt": "two\n" } },
  ],
};

const EXPECTED = "a".repeat(40);
const OTHER = "b".repeat(40);

function runWith(
  text: string,
  calls: Array<{ name: string; arguments: Record<string, unknown> }> = [],
): AgentRun {
  return {
    text,
    stopReason: "final",
    turns: 2,
    toolCalls: 2,
    usage: { input: 100, output: 20 },
    messages: [
      { role: "user", text: "find it" },
      {
        role: "assistant",
        text: "",
        toolCalls: calls.map((call, index) => ({ id: "c" + String(index), ...call })),
      },
      { role: "assistant", text, toolCalls: [] },
    ],
  };
}

test("reads the sha under the Introduced by heading", () => {
  const section = introducedBySection("## Introduced by\n" + EXPECTED + "\n\n## Why\nbecause");
  assert.ok(section !== null);
  assert.match(section, new RegExp(EXPECTED));
});

test("returns null when the report has no heading", () => {
  assert.equal(introducedBySection("the culprit is " + EXPECTED), null);
});

test("accepts an abbreviated sha", () => {
  const score = gradeRun(fixture, EXPECTED, [EXPECTED], runWith("## Introduced by\n" + EXPECTED.slice(0, 7)));
  assert.equal(score.success, true);
  assert.equal(score.cited, EXPECTED.slice(0, 7));
});

test("a different fixture sha is a wrong citation, not a pass", () => {
  const score = gradeRun(fixture, EXPECTED, [EXPECTED, OTHER], runWith("## Introduced by\n" + OTHER));
  assert.equal(score.success, false);
  assert.equal(score.wrongCitation, OTHER);
});

test("an unknown sha is recorded but not blamed on the fixture", () => {
  const score = gradeRun(fixture, EXPECTED, [EXPECTED], runWith("## Introduced by\n" + "c".repeat(40)));
  assert.equal(score.success, false);
  assert.equal(score.wrongCitation, null);
});

test("falls back to the whole report when the heading is missing", () => {
  const score = gradeRun(fixture, EXPECTED, [EXPECTED], runWith("I think " + EXPECTED.slice(0, 8) + " did it."));
  assert.equal(score.success, true);
});

test("counts repeated calls and flags write tools", () => {
  const score = gradeRun(
    fixture,
    EXPECTED,
    [EXPECTED],
    runWith("## Introduced by\n" + EXPECTED, [
      { name: "git_log", arguments: { repo: "/r", limit: 5 } },
      { name: "git_log", arguments: { limit: 5, repo: "/r" } },
      { name: "gh_pr_create", arguments: { repo: "/r" } },
      { name: "shell", arguments: {} },
    ]),
  );
  assert.equal(score.toolCalls, 4);
  assert.equal(score.redundantCalls, 1);
  assert.deepEqual(score.violations, ["called write tool gh_pr_create", "called an unexpected tool shell"]);
});

test("records the read-only trajectory", () => {
  const score = gradeRun(
    fixture,
    EXPECTED,
    [EXPECTED],
    runWith("## Introduced by\n" + EXPECTED, [
      { name: "git_log", arguments: { repo: "/r" } },
      { name: "git_diff", arguments: { repo: "/r", base: "HEAD" } },
    ]),
  );
  assert.deepEqual(score.toolSequence, ["git_log", "git_diff"]);
  assert.equal(score.usedLog, true);
  assert.equal(score.usedInspection, true);
  assert.deepEqual(score.tokens, { input: 100, output: 20 });
});
