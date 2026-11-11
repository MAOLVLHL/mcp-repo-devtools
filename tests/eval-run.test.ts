import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ScriptedProvider } from "../src/agent/provider.js";
import { buildRepo, loadFixtures, parseFixture } from "../src/eval/fixture.js";
import { oracleTurns } from "../src/eval/oracle.js";
import { runCase, taskPrompt } from "../src/eval/run.js";
import { summarize } from "../src/eval/suite.js";

const FIXTURES = fileURLToPath(new URL("../eval/fixtures", import.meta.url));

const gitAvailable = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test("the task asks for the sha the tools can actually print", () => {
  // git_log uses %h, so the full sha is not reachable from the typed arm. Asking for
  // "the full commit sha" made four of the first thirty cases unwinnable, and the
  // models padded the short sha rather than say so.
  const prompt = taskPrompt(
    { id: "x", symptom: "a test fails", expected_commit: 1, commits: [] },
    { repo: "/tmp/repo", shas: [], expectedSha: "abc1234" },
    "mcp",
  );
  assert.match(prompt, /exactly as the history printed it/);
  assert.doesNotMatch(prompt, /full commit sha/);
});

test("rejects a fixture whose expected_commit is out of range", () => {
  const bad = {
    id: "bad",
    symptom: "x",
    expected_commit: 3,
    commits: [{ message: "only one", files: { "a.txt": "a\n" } }],
  };
  assert.throws(() => parseFixture(bad, "bad.json"), /expected_commit/);
});

test("rejects a path that escapes the repository", () => {
  const bad = {
    id: "bad",
    symptom: "x",
    expected_commit: 1,
    commits: [{ message: "one", files: { "../escape.txt": "a\n" } }],
  };
  assert.throws(() => parseFixture(bad, "bad.json"), /escapes the repository/);
});

test("every shipped fixture parses", () => {
  const fixtures = loadFixtures(FIXTURES);
  assert.equal(fixtures.length, 40);
  for (const fixture of fixtures) {
    assert.ok(fixture.commits.length >= fixture.expected_commit);
  }
});

test("builds the same shas twice", { skip: !gitAvailable }, async () => {
  const fixtures = loadFixtures(FIXTURES);
  const fixture = fixtures.find((candidate) => candidate.id === "refresh-token-keyerror");
  assert.ok(fixture !== undefined);
  const root = mkdtempSync(path.join(tmpdir(), "repo-devtools-eval-build-"));
  try {
    const first = await buildRepo(fixture, path.join(root, "one"));
    const second = await buildRepo(fixture, path.join(root, "two"));
    assert.deepEqual(first.shas, second.shas);
    assert.equal(first.expectedSha, second.expectedSha);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the oracle passes on the MCP arm", { skip: !gitAvailable }, async () => {
  const fixtures = loadFixtures(FIXTURES);
  const fixture = fixtures.find((candidate) => candidate.id === "refresh-token-keyerror");
  assert.ok(fixture !== undefined);
  const root = mkdtempSync(path.join(tmpdir(), "repo-devtools-eval-mcp-"));
  try {
    const result = await runCase(fixture, root, {
      arm: "mcp",
      providerFor: (build) => new ScriptedProvider(oracleTurns(fixture, build, "mcp")),
    });
    assert.equal(result.score.success, true);
    assert.deepEqual(result.score.toolSequence, ["git_log", "git_diff"]);
    assert.deepEqual(result.score.violations, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the oracle passes on the baseline arm", { skip: !gitAvailable }, async () => {
  const fixtures = loadFixtures(FIXTURES);
  const fixture = fixtures.find((candidate) => candidate.id === "pagination-repeats-first-page");
  assert.ok(fixture !== undefined);
  const root = mkdtempSync(path.join(tmpdir(), "repo-devtools-eval-bash-"));
  try {
    const result = await runCase(fixture, root, {
      arm: "baseline",
      providerFor: (build) => new ScriptedProvider(oracleTurns(fixture, build, "baseline")),
    });
    assert.equal(result.score.success, true);
    assert.deepEqual(result.score.toolSequence, ["git", "git"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a fixture that promises the wrong commit scores zero", { skip: !gitAvailable }, async () => {
  const fixtures = loadFixtures(FIXTURES);
  const fixture = fixtures.find((candidate) => candidate.id === "sort-order-depends-on-locale");
  assert.ok(fixture !== undefined);
  const root = mkdtempSync(path.join(tmpdir(), "repo-devtools-eval-wrong-"));
  try {
    const result = await runCase(fixture, root, {
      arm: "mcp",
      providerFor: (build) => {
        const turns = oracleTurns(fixture, build, "mcp");
        const last = turns[turns.length - 1];
        if (last !== undefined && typeof last === "object" && "text" in last) {
          turns[turns.length - 1] = {
            text: "## Introduced by\n" + build.shas[0],
            toolCalls: [],
          };
        }
        return new ScriptedProvider(turns);
      },
    });
    assert.equal(result.score.success, false);
    assert.equal(result.score.wrongCitation, result.build.shas[0]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("summarises a suite from its case results", { skip: !gitAvailable }, async () => {
  const fixtures = loadFixtures(FIXTURES).slice(0, 2);
  const root = mkdtempSync(path.join(tmpdir(), "repo-devtools-eval-summary-"));
  try {
    const results = [];
    for (const fixture of fixtures) {
      results.push(
        await runCase(fixture, root, {
          arm: "mcp",
          providerFor: (build) => new ScriptedProvider(oracleTurns(fixture, build, "mcp")),
        }),
      );
    }
    const summary = summarize(results);
    assert.equal(summary.cases, 2);
    assert.equal(summary.passed, 2);
    assert.equal(summary.successRate, 1);
    assert.equal(summary.violations, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});