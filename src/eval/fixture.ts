/**
 * Fixtures are data, not code: a repository baked from a handful of commits, the
 * symptom a user would paste into a chat, and the commit that actually introduced it.
 *
 * Nothing here touches the network. Every fixture is reproducible byte for byte
 * because the commit dates are fixed, which is what makes a score comparable across
 * runs and across models.
 */

import { execFile } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { CULPRIT_SHA, parseGithubScenario, type GithubScenario } from "./github-fixture.js";

const run = promisify(execFile);
/** Fixed so two builds of the same fixture produce the same shas. */
const BASE_TIME = Date.parse("2026-01-01T00:00:00Z");

export interface FixtureCommit {
  message: string;
  /** Path relative to the repository root -> file content. */
  files: Record<string, string>;
}

/** Where the evidence for a fixture lives: the checkout, or a CI run plus the checkout. */
export type FixtureKind = "git" | "github";

export interface Fixture {
  id: string;
  /** Defaults to "git"; "github" adds a stub of the checks, jobs and log endpoints. */
  kind: FixtureKind;
  /** The failing test, as a user would report it. */
  symptom: string;
  /** 1-based index into commits: the commit that introduced the regression. */
  expected_commit: number;
  commits: FixtureCommit[];
  /**
   * Bake the checkout as a depth-1 clone: one commit holding the tree of HEAD, with
   * the commits that came before it gone. The only surviving pointer to the change is
   * the CI run's head sha, which is why a shallow fixture is always kind "github".
   */
  shallow?: boolean;
  /** Present exactly when kind is "github". */
  github?: GithubScenario;
}

export interface BuiltRepo {
  repo: string;
  /** Every commit sha the checkout still has, oldest first. */
  shas: string[];
  /** The culprit's sha, which a shallow checkout no longer contains. */
  expectedSha: string;
  /** The CI scenario with its sha resolved; present exactly for kind "github". */
  github?: GithubScenario;
  shallow: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseFixture(value: unknown, source: string): Fixture {
  const record = asRecord(value);
  if (record === null) {
    throw new Error(source + ": a fixture must be a JSON object");
  }
  const id = record["id"];
  const symptom = record["symptom"];
  const expected = record["expected_commit"];
  const commits = record["commits"];
  const kind = record["kind"] ?? "git";
  const github = record["github"];
  const shallow = record["shallow"] ?? false;
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new Error(source + ": id must be a non-empty string");
  }
  if (typeof symptom !== "string" || symptom.trim().length === 0) {
    throw new Error(source + ": symptom must be a non-empty string");
  }
  if (typeof expected !== "number" || !Number.isInteger(expected)) {
    throw new Error(source + ": expected_commit must be an integer");
  }
  if (!Array.isArray(commits) || commits.length === 0) {
    throw new Error(source + ": commits must be a non-empty array");
  }
  const parsedCommits: FixtureCommit[] = commits.map((commit: unknown, index: number) => {
    const entry = asRecord(commit);
    if (entry === null) {
      throw new Error(source + ": commit " + String(index + 1) + " must be an object");
    }
    const message = entry["message"];
    const files = asRecord(entry["files"]);
    if (typeof message !== "string" || message.trim().length === 0) {
      throw new Error(source + ": commit " + String(index + 1) + " needs a message");
    }
    if (files === null) {
      throw new Error(source + ": commit " + String(index + 1) + " needs a files object");
    }
    const contents: Record<string, string> = {};
    for (const [file, content] of Object.entries(files)) {
      if (typeof content !== "string") {
        throw new Error(source + ": " + file + " in commit " + String(index + 1) + " must be a string");
      }
      if (path.isAbsolute(file) || file.split(/[\\/]/).includes("..")) {
        throw new Error(source + ": " + file + " escapes the repository");
      }
      contents[file] = content;
    }
    return { message, files: contents };
  });
  if (expected < 1 || expected > parsedCommits.length) {
    throw new Error(source + ": expected_commit must be between 1 and " + String(parsedCommits.length));
  }
  if (kind !== "git" && kind !== "github") {
    throw new Error(source + ': kind must be "git" or "github"');
  }
  if (typeof shallow !== "boolean") {
    throw new Error(source + ": shallow must be a boolean");
  }
  if (shallow && kind !== "github") {
    throw new Error(source + ': a shallow fixture needs kind: "github" (the run sha is the only evidence left)');
  }
  if (kind === "github") {
    return {
      id,
      kind,
      symptom,
      expected_commit: expected,
      commits: parsedCommits,
      shallow,
      github: parseGithubScenario(github, source),
    };
  }
  if (github !== undefined) {
    throw new Error(source + ': a "github" block needs kind: "github"');
  }
  return { id, kind: "git", symptom, expected_commit: expected, commits: parsedCommits, shallow: false };
}

export function loadFixtures(dir: string): Fixture[] {
  const names = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort();
  if (names.length === 0) {
    throw new Error("no fixtures found in " + dir);
  }
  return names.map((name) => {
    const raw: unknown = JSON.parse(readFileSync(path.join(dir, name), "utf8"));
    return parseFixture(raw, name);
  });
}

/** Every fixture is baked into a real repository, GitHub-shaped ones included. */
export async function buildRepo(fixture: Fixture, root: string): Promise<BuiltRepo> {
  const repo = path.join(root, fixture.id);
  mkdirSync(repo, { recursive: true });
  const git = async (args: string[], env: NodeJS.ProcessEnv = {}) => {
    const result = await run("git", args, {
      cwd: repo,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", ...env },
      maxBuffer: 4 * 1024 * 1024,
    });
    return String(result.stdout);
  };

  await git(["init", "-q", "-b", "main"]);
  await git(["config", "user.email", "fixture@example.com"]);
  await git(["config", "user.name", "Fixture"]);
  await git(["config", "commit.gpgsign", "false"]);

  for (const [index, commit] of fixture.commits.entries()) {
    for (const [file, content] of Object.entries(commit.files)) {
      const absolute = path.join(repo, file);
      mkdirSync(path.dirname(absolute), { recursive: true });
      writeFileSync(absolute, content, "utf8");
    }
    await git(["add", "-A"]);
    const stamp = new Date(BASE_TIME + index * 60_000).toISOString();
    await git(["commit", "-q", "-m", commit.message], {
      GIT_AUTHOR_DATE: stamp,
      GIT_COMMITTER_DATE: stamp,
    });
  }

  let shas = (await git(["rev-list", "--reverse", "HEAD"]))
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
  const expectedSha = shas[fixture.expected_commit - 1];
  if (expectedSha === undefined) {
    throw new Error(fixture.id + ": expected_commit points past the last commit");
  }

  let github: GithubScenario | undefined;
  if (fixture.github !== undefined) {
    github = {
      ...fixture.github,
      sha: fixture.github.sha === CULPRIT_SHA ? expectedSha : fixture.github.sha,
    };
  }

  const shallow = fixture.shallow === true;
  if (shallow) {
    const last = fixture.commits[fixture.commits.length - 1];
    if (last === undefined) {
      throw new Error(fixture.id + ": a shallow fixture still needs a commit to keep");
    }
    const stamp = new Date(BASE_TIME + (fixture.commits.length - 1) * 60_000).toISOString();
    rmSync(path.join(repo, ".git"), { recursive: true, force: true });
    await git(["init", "-q", "-b", "main"]);
    await git(["config", "user.email", "fixture@example.com"]);
    await git(["config", "user.name", "Fixture"]);
    await git(["config", "commit.gpgsign", "false"]);
    await git(["add", "-A"]);
    await git(["commit", "-q", "-m", last.message], {
      GIT_AUTHOR_DATE: stamp,
      GIT_COMMITTER_DATE: stamp,
    });
    shas = [(await git(["rev-parse", "HEAD"])).trim()];
    const survivor = shas[0];
    if (survivor === undefined) {
      throw new Error(fixture.id + ": the shallow rebuild produced no commit");
    }
    // Re-committing changes the sha of the commit that survives the clone. The run
    // tested that one, and the culprit is an earlier commit whose sha is now only
    // reachable through the log.
    if (github !== undefined) {
      github = { ...github, sha: survivor, culprit_sha: expectedSha };
    }
  }

  return { repo, shas, expectedSha, github, shallow };
}