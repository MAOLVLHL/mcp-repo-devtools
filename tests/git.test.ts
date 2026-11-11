import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { assertSafeRef, gitDiff, gitLog, gitStatus, runGit } from "../src/git.js";
import type { RequestContext } from "../src/request-context.js";

const gitAvailable = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

function makeRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "repo-devtools-git-"));
  const g = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "test@example.com");
  g("config", "user.name", "Test User");
  g("config", "commit.gpgsign", "false");
  mkdirSync(path.join(dir, "src"));
  writeFileSync(path.join(dir, "src", "a.ts"), "export const a = 1;\n");
  g("add", ".");
  g("commit", "-q", "-m", "feat: first commit");
  return dir;
}

test("git_status reports the branch and a clean tree", { skip: !gitAvailable }, async () => {
  const repo = makeRepo();
  try {
    const status = await gitStatus(repo);
    assert.equal(status.branch, "main");
    assert.equal(status.changes.length, 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("git_status lists untracked and modified paths", { skip: !gitAvailable }, async () => {
  const repo = makeRepo();
  try {
    writeFileSync(path.join(repo, "notes.md"), "hello\n");
    writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 2;\n");
    const status = await gitStatus(repo);
    const byPath = new Map(status.changes.map((change) => [change.path, change.status]));
    assert.equal(byPath.get("notes.md"), "untracked");
    assert.equal(byPath.get("src/a.ts"), "modified");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("git_log returns the newest commit first", { skip: !gitAvailable }, async () => {
  const repo = makeRepo();
  try {
    writeFileSync(path.join(repo, "src", "b.ts"), "export const b = 2;\n");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "pipe" });
    execFileSync("git", ["commit", "-q", "-m", "feat: second commit"], { cwd: repo, stdio: "pipe" });

    const entries = await gitLog(repo, { limit: 10 });
    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.subject, "feat: second commit");
    assert.match(entries[0]?.hash ?? "", /^[0-9a-f]{7,}$/);
    assert.equal(entries[1]?.subject, "feat: first commit");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("git_log scopes history to a path", { skip: !gitAvailable }, async () => {
  const repo = makeRepo();
  try {
    writeFileSync(path.join(repo, "other.ts"), "export const other = 1;\n");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "pipe" });
    execFileSync("git", ["commit", "-q", "-m", "feat: touching other"], { cwd: repo, stdio: "pipe" });

    const scoped = await gitLog(repo, { limit: 10, path: "other.ts" });
    assert.equal(scoped.length, 1);
    assert.equal(scoped[0]?.subject, "feat: touching other");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("git_diff defaults to a stat summary and can return a patch", { skip: !gitAvailable }, async () => {
  const repo = makeRepo();
  try {
    writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 2;\nexport const c = 3;\n");

    const stat = await gitDiff(repo, { mode: "stat", contextLines: 3 });
    assert.match(stat, /src\/a\.ts/);
    assert.doesNotMatch(stat, /\+export const c = 3;/);

    const patch = await gitDiff(repo, { mode: "patch", contextLines: 3 });
    assert.match(patch, /\+export const c = 3;/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("git_diff reports a clean tree instead of an empty string", { skip: !gitAvailable }, async () => {
  const repo = makeRepo();
  try {
    const text = await gitDiff(repo, { mode: "patch", contextLines: 3 });
    assert.match(text, /no changes against HEAD/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a cancelled request stops git instead of waiting for it", { skip: !gitAvailable }, async () => {
  const repo = makeRepo();
  const controller = new AbortController();
  controller.abort();
  const context: RequestContext = { signal: controller.signal, progress: () => {} };
  try {
    await assert.rejects(() => gitStatus(repo, context), /git status cancelled by the client/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("runGit refuses subcommands outside the allowlist", async () => {
  await assert.rejects(() => runGit(process.cwd(), ["push", "origin", "main"]), /refusing to run git subcommand/);
  await assert.rejects(() => runGit(process.cwd(), ["config", "user.email", "x@y.z"]), /refusing to run git subcommand/);
});

test("runGit refuses dangerous global flags", async () => {
  await assert.rejects(() => runGit(process.cwd(), ["log", "-c", "core.pager=calc"]), /refusing to pass git flag/);
  await assert.rejects(() => runGit(process.cwd(), ["log", "--upload-pack=calc"]), /refusing to pass git flag/);
});

test("assertSafeRef rejects flag-shaped refs and control characters", () => {
  assert.equal(assertSafeRef("main"), "main");
  assert.equal(assertSafeRef("HEAD~1"), "HEAD~1");
  assert.throws(() => assertSafeRef("--upload-pack=calc"), /not a valid git ref/);
  assert.throws(() => assertSafeRef("a b"), /not a valid git ref/);
  assert.throws(() => assertSafeRef(""), /not a valid git ref/);
});
