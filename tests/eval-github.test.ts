import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ScriptedProvider } from "../src/agent/provider.js";
import { buildRepo, loadFixtures, parseFixture } from "../src/eval/fixture.js";
import { installGithubStub, logMarker, parseGithubScenario } from "../src/eval/github-fixture.js";
import { oracleTurns } from "../src/eval/oracle.js";
import { runCase } from "../src/eval/run.js";
import { formatKinds, summarizeByKind } from "../src/eval/suite.js";

const FIXTURES = fileURLToPath(new URL("../eval/fixtures", import.meta.url));

const gitAvailable = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const SCENARIO = {
  repo: "acme/shop",
  ref: "main",
  run: 4181,
  sha: "a".repeat(40),
  jobs: [
    {
      id: 19001,
      name: "pytest (3.12)",
      conclusion: "failure",
      steps: [
        { name: "Set up job", conclusion: "success" },
        { name: "Run tests", conclusion: "failure" },
      ],
    },
  ],
  log: "2026-01-02T09:12:31.000Z AssertionError: assert '42' == 'acme:42'\n",
};

test("ten fixtures carry a CI run; the rest stay checkouts", () => {
  const fixtures = loadFixtures(FIXTURES);
  const github = fixtures.filter((fixture) => fixture.kind === "github");
  const shallow = github.filter((fixture) => fixture.shallow === true);
  assert.equal(github.length, 10);
  assert.equal(shallow.length, 4);
  assert.equal(fixtures.length - github.length, 30);
  for (const fixture of github) {
    assert.ok(fixture.github !== undefined);
    assert.ok(fixture.github.log.length > 0);
    assert.equal(fixture.commits.length >= fixture.expected_commit, true);
  }
  for (const fixture of shallow) {
    assert.equal(fixture.github?.sha, "culprit", fixture.id + " should let the builder resolve the run sha");
  }
});

test("a shallow fixture keeps one commit, and the culprit is only in the log", { skip: !gitAvailable }, async () => {
  const fixtures = loadFixtures(FIXTURES);
  const fixture = fixtures.find((candidate) => candidate.id === "shallow-ci-slug-keeps-punctuation");
  assert.ok(fixture !== undefined);
  const root = mkdtempSync(path.join(tmpdir(), "repo-devtools-eval-shallow-"));
  try {
    const result = await runCase(fixture, root, {
      arm: "mcp",
      providerFor: (build) => new ScriptedProvider(oracleTurns(fixture, build, "mcp")),
    });
    assert.equal(result.build.shallow, true);
    assert.equal(result.build.shas.length, 1);
    // The run tested the commit the clone keeps; the culprit came before it and did not
    // survive, so its sha has to be the one the log printed.
    assert.equal(result.build.shas[0], result.build.github?.sha);
    assert.notEqual(result.build.shas[0], result.build.expectedSha);
    assert.equal(result.build.github?.culprit_sha, result.build.expectedSha);
    assert.equal(result.score.success, true);
    assert.deepEqual(result.score.toolSequence, ["gh_ci_failures", "git_log"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a shallow checkout has no history for git to read", { skip: !gitAvailable }, async () => {
  const fixtures = loadFixtures(FIXTURES);
  const fixture = fixtures.find((candidate) => candidate.id === "shallow-ci-port-parser-accepts-junk");
  assert.ok(fixture !== undefined);
  const root = mkdtempSync(path.join(tmpdir(), "repo-devtools-eval-shallow-log-"));
  try {
    const result = await runCase(fixture, root, {
      arm: "baseline",
      providerFor: (build) => new ScriptedProvider(oracleTurns(fixture, build, "baseline")),
    });
    const log = execFileSync("git", ["-C", result.build.repo, "log", "--format=%H"], { encoding: "utf8" });
    assert.equal(log.trim().split("\n").length, 1);
    assert.doesNotMatch(log, new RegExp(result.build.expectedSha));
    assert.equal(result.score.success, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the stubbed log names the sha the run tested", { skip: !gitAvailable }, async () => {
  const fixtures = loadFixtures(FIXTURES);
  const fixture = fixtures.find((candidate) => candidate.id === "shallow-ci-rounds-each-line-first");
  assert.ok(fixture !== undefined);
  const root = mkdtempSync(path.join(tmpdir(), "repo-devtools-eval-log-"));
  try {
    const build = await buildRepo(fixture, root);
    assert.ok(build.github !== undefined);
    const stub = installGithubStub(build.github);
    try {
      const redirect = await fetch("https://logs.invalid/7002.log", { redirect: "manual" });
      const body = await redirect.text();
      // The clone line names the commit the run tested; the blame line names the culprit.
      assert.match(body, new RegExp("git fetch --depth 1 origin " + String(build.github.sha)));
      assert.match(body, new RegExp(build.expectedSha.slice(0, 7) + " \\(Fixture "));
      assert.match(body, new RegExp("git show --stat --oneline " + build.expectedSha.slice(0, 7)));
      // The run tested a later commit than the one it blames.
      assert.doesNotMatch(body, new RegExp("HEAD is now at " + build.expectedSha.slice(0, 7)));
      assert.doesNotMatch(body, /\{\{/);
    } finally {
      stub.restore();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a shallow git fixture: only a run sha can carry the evidence', () => {
  const bad = {
    id: "bad",
    symptom: "x",
    expected_commit: 1,
    shallow: true,
    commits: [{ message: "one", files: { "a.py": "a = 1\n" } }],
  };
  assert.throws(() => parseFixture(bad, "bad.json"), /shallow fixture needs kind: "github"/);
});

test('the run sha may be the literal "culprit", and nothing else odd', () => {
  const fixture = {
    id: "ok",
    kind: "github",
    symptom: "x",
    expected_commit: 1,
    shallow: true,
    commits: [{ message: "one", files: { "a.py": "a = 1\n" } }],
    github: { ...SCENARIO, sha: "culprit" },
  };
  assert.equal(parseFixture(fixture, "ok.json").github?.sha, "culprit");
  assert.throws(
    () => parseFixture({ ...fixture, github: { ...SCENARIO, sha: "xyz" } }, "bad.json"),
    /github\.sha must be a commit sha/,
  );
});

test("rejects a github fixture without a log", () => {
  const bad = {
    id: "bad",
    kind: "github",
    symptom: "x",
    expected_commit: 1,
    commits: [{ message: "one", files: { "a.py": "a = 1\n" } }],
    github: { repo: "acme/shop", ref: "main", run: 1, jobs: SCENARIO.jobs, sha: SCENARIO.sha },
  };
  assert.throws(() => parseFixture(bad, "bad.json"), /github\.log/);
});

test("rejects a github block on a git fixture", () => {
  const bad = {
    id: "bad",
    symptom: "x",
    expected_commit: 1,
    commits: [{ message: "one", files: { "a.py": "a = 1\n" } }],
    github: SCENARIO,
  };
  assert.throws(() => parseFixture(bad, "bad.json"), /needs kind: "github"/);
});

test("rejects a scenario whose repo is not owner/name", () => {
  assert.throws(
    () => parseGithubScenario({ ...SCENARIO, repo: "acme" }, "x.json"),
    /github\.repo must look like owner\/name/,
  );
});

test("the stub answers the three routes ciFailures asks for", async () => {
  const original = globalThis.fetch;
  const stub = installGithubStub(SCENARIO);
  try {
    const checks = await fetch("https://api.github.com/repos/acme/shop/commits/main/check-runs?per_page=100&filter=latest");
    assert.equal(checks.status, 200);
    const body = (await checks.json()) as { check_runs: Array<{ conclusion: string; head_sha: string }> };
    assert.equal(body.check_runs[0]?.conclusion, "failure");
    assert.equal(body.check_runs[0]?.head_sha, SCENARIO.sha);

    const jobs = await fetch("https://api.github.com/repos/acme/shop/actions/runs/4181/jobs?per_page=100&filter=latest");
    const jobsBody = (await jobs.json()) as { jobs: Array<{ id: number }> };
    assert.equal(jobsBody.jobs[0]?.id, 19001);

    const redirect = await fetch("https://api.github.com/repos/acme/shop/actions/jobs/19001/logs", { redirect: "manual" });
    assert.equal(redirect.status, 302);
    const location = redirect.headers.get("location");
    assert.equal(location, "https://logs.invalid/19001.log");

    const download = await fetch(String(location));
    assert.equal(await download.text(), SCENARIO.log);

    const missing = await fetch("https://api.github.com/repos/acme/shop/pulls/1");
    assert.equal(missing.status, 404);
    assert.equal(await missing.text(), "the fixture has no route for https://api.github.com/repos/acme/shop/pulls/1");
    assert.equal(stub.calls.length, 5);
  } finally {
    stub.restore();
  }
  assert.equal(globalThis.fetch, original);
});

test("restoring the stub twice keeps the original fetch", () => {
  const original = globalThis.fetch;
  const stub = installGithubStub(SCENARIO);
  stub.restore();
  stub.restore();
  assert.equal(globalThis.fetch, original);
});

test("logMarker names the line a report is expected to quote", () => {
  assert.match(logMarker(SCENARIO), /AssertionError: assert '42' == 'acme:42'/);
});

test("the oracle solves a CI fixture on the typed arm", { skip: !gitAvailable }, async () => {
  const fixtures = loadFixtures(FIXTURES);
  const fixture = fixtures.find((candidate) => candidate.id === "ci-log-tenancy-lost-in-the-cache-key");
  assert.ok(fixture !== undefined);
  const root = mkdtempSync(path.join(tmpdir(), "repo-devtools-eval-ci-"));
  try {
    const result = await runCase(fixture, root, {
      arm: "mcp",
      providerFor: (build) => new ScriptedProvider(oracleTurns(fixture, build, "mcp")),
    });
    assert.equal(result.score.success, true);
    assert.deepEqual(result.score.toolSequence, ["gh_ci_failures", "git_log"]);
    assert.deepEqual(result.score.violations, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the scripted raw arm cannot read a CI log, and the score says so", { skip: !gitAvailable }, async () => {
  const fixtures = loadFixtures(FIXTURES);
  const fixture = fixtures.find((candidate) => candidate.id === "ci-log-a-missing-user-stops-rejecting");
  assert.ok(fixture !== undefined);
  const root = mkdtempSync(path.join(tmpdir(), "repo-devtools-eval-ci-raw-"));
  try {
    const result = await runCase(fixture, root, {
      arm: "baseline",
      providerFor: (build) => new ScriptedProvider(oracleTurns(fixture, build, "baseline")),
    });
    assert.equal(result.score.success, false);
    assert.equal(result.score.cited, null);
    assert.deepEqual(result.score.toolSequence, ["git"]);
    assert.match(result.run.text, /cannot reach/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a suite reports the two kinds apart", { skip: !gitAvailable }, async () => {
  const fixtures = loadFixtures(FIXTURES);
  const ci = fixtures.find((candidate) => candidate.id === "ci-log-backoff-multiplied-in-milliseconds");
  const repo = fixtures.find((candidate) => candidate.id === "refresh-token-keyerror");
  assert.ok(ci !== undefined && repo !== undefined);
  const root = mkdtempSync(path.join(tmpdir(), "repo-devtools-eval-kinds-"));
  try {
    const results = [];
    for (const fixture of [ci, repo]) {
      results.push(
        await runCase(fixture, root, {
          arm: "mcp",
          providerFor: (build) => new ScriptedProvider(oracleTurns(fixture, build, "mcp")),
        }),
      );
    }
    const kinds = summarizeByKind(results);
    assert.deepEqual(
      kinds.map((entry) => entry.kind),
      ["git", "github"],
    );
    assert.equal(kinds[0]?.summary.passed, 1);
    assert.equal(kinds[1]?.summary.passed, 1);
    assert.match(formatKinds(kinds), /git fixtures: 1\/1 \(100%\)  ·  github fixtures: 1\/1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
