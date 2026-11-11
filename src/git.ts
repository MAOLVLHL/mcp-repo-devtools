/**
 * Read-only git access. Every invocation goes through execFile with an argv
 * array, a subcommand allowlist, a flag denylist and a scrubbed environment.
 */

import { execFile } from "node:child_process";
import { redact } from "./text.js";

const TIMEOUT_MS = 10_000;
const MAX_BUFFER = 4 * 1024 * 1024;

export const ALLOWED_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "status",
  "log",
  "diff",
  "show",
  "blame",
  "rev-parse",
  "rev-list",
  "ls-files",
  "grep",
  "branch",
  "merge-base",
  "describe",
  "show-ref",
]);

/** Flags that can turn a read-only command into code execution or a redirect. */
const FORBIDDEN_FLAGS: ReadonlySet<string> = new Set([
  "-c",
  "-C",
  "--exec-path",
  "--upload-pack",
  "--receive-pack",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--config-env",
  "--config",
  "--output",
]);

const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/@{}~^:+-]*$/;

export class GitError extends Error {
  readonly exitCode: number | null;

  constructor(message: string, exitCode: number | null) {
    super(message);
    this.name = "GitError";
    this.exitCode = exitCode;
  }
}

/** Model-supplied refs are never allowed to look like flags. */
export function assertSafeRef(ref: string, label = "ref"): string {
  const value = ref.trim();
  if (
    value.length === 0 ||
    value.length > 256 ||
    value.startsWith("-") ||
    !REF_PATTERN.test(value)
  ) {
    throw new Error(label + " is not a valid git ref: " + JSON.stringify(ref));
  }
  return value;
}

/** Model-supplied paths must be relative and free of control characters. */
export function assertSafePath(value: string, label = "path"): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 1024 || /[\0\r\n]/.test(trimmed)) {
    throw new Error(label + " is not a valid path: " + JSON.stringify(value));
  }
  return trimmed;
}

function buildEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "USERPROFILE", "SystemRoot", "TMP", "TEMP", "LANG", "LC_ALL"]) {
    const value = process.env[key];
    if (value) {
      env[key] = value;
    }
  }
  env["GIT_OPTIONAL_LOCKS"] = "0";
  env["GIT_TERMINAL_PROMPT"] = "0";
  env["GIT_PAGER"] = "cat";
  env["GIT_CONFIG_COUNT"] = "1";
  env["GIT_CONFIG_KEY_0"] = "core.quotepath";
  env["GIT_CONFIG_VALUE_0"] = "false";
  return env;
}

function summarizeStderr(stderr: string, fallback: string): string {
  const clean = redact(stderr.trim() || fallback).replace(/\r/g, "");
  const clipped = clean.split("\n").slice(0, 20).join("\n");
  return clipped.length > 800 ? clipped.slice(0, 800) + "…" : clipped;
}

function execGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        env: buildEnv(),
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error) {
          const code = typeof error.code === "number" ? error.code : null;
          reject(new GitError("git " + args[0] + " failed: " + summarizeStderr(stderr, error.message), code));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

/**
 * Run a whitelisted git subcommand inside `cwd` and return stdout.
 * Extra flags supplied by callers are checked against the denylist.
 */
export async function runGit(cwd: string, args: string[]): Promise<string> {
  const subcommand = args[0];
  if (!subcommand || !ALLOWED_SUBCOMMANDS.has(subcommand)) {
    throw new Error("refusing to run git subcommand: " + String(subcommand));
  }
  for (const arg of args.slice(1)) {
    const flag = arg.split("=")[0] ?? arg;
    if (FORBIDDEN_FLAGS.has(flag)) {
      throw new Error("refusing to pass git flag: " + flag);
    }
  }
  const { stdout } = await execGit(cwd, args);
  return stdout;
}

export interface WorkingTreeChange {
  status: string;
  path: string;
}

export interface WorkingTreeStatus {
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  changes: WorkingTreeChange[];
  truncated: boolean;
}

const MAX_STATUS_ENTRIES = 200;

function describeStatus(code: string): string {
  const index = code[0] ?? ".";
  const worktree = code[1] ?? ".";
  if (index === "?" || worktree === "?") {
    return "untracked";
  }
  if (index === "R" || worktree === "R") {
    return "renamed";
  }
  if (index === "A" || worktree === "A") {
    return "added";
  }
  if (index === "D" || worktree === "D") {
    return "deleted";
  }
  if (index === "M" || worktree === "M") {
    return "modified";
  }
  if (index === "U" || worktree === "U") {
    return "conflicted";
  }
  return "changed";
}

/** Parse `git status --porcelain=v2 --branch` into a compact summary. */
export async function gitStatus(repo: string): Promise<WorkingTreeStatus> {
  const stdout = await runGit(repo, ["status", "--porcelain=v2", "--branch", "--untracked-files=normal"]);
  const result: WorkingTreeStatus = {
    branch: "(detached)",
    upstream: null,
    ahead: 0,
    behind: 0,
    changes: [],
    truncated: false,
  };

  for (const line of stdout.split("\n")) {
    if (line.startsWith("# branch.head ")) {
      result.branch = line.slice("# branch.head ".length).trim();
      continue;
    }
    if (line.startsWith("# branch.upstream ")) {
      result.upstream = line.slice("# branch.upstream ".length).trim();
      continue;
    }
    if (line.startsWith("# branch.ab ")) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(line);
      if (match) {
        result.ahead = Number(match[1]);
        result.behind = Number(match[2]);
      }
      continue;
    }
    if (line.startsWith("1 ") || line.startsWith("2 ")) {
      const fields = line.split(" ");
      const code = fields[1] ?? "..";
      const path = line.startsWith("2 ")
        ? (fields.slice(9).join(" ").split("\t")[0] ?? "")
        : fields.slice(8).join(" ");
      if (result.changes.length >= MAX_STATUS_ENTRIES) {
        result.truncated = true;
        continue;
      }
      result.changes.push({ status: describeStatus(code), path });
      continue;
    }
    if (line.startsWith("? ")) {
      if (result.changes.length >= MAX_STATUS_ENTRIES) {
        result.truncated = true;
        continue;
      }
      result.changes.push({ status: "untracked", path: line.slice(2) });
    }
  }

  return result;
}

export interface LogEntry {
  hash: string;
  date: string;
  author: string;
  subject: string;
}

export interface LogOptions {
  path?: string;
  limit: number;
}

/** Return the newest commits, one line each. */
export async function gitLog(repo: string, options: LogOptions): Promise<LogEntry[]> {
  const args = [
    "log",
    "-n" + String(options.limit),
    "--date=short",
    "--pretty=format:%h%x09%ad%x09%an%x09%s",
  ];
  if (options.path) {
    args.push("--", assertSafePath(options.path));
  }
  const stdout = await runGit(repo, args);
  return stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [hash = "", date = "", author = "", ...rest] = line.split("\t");
      return { hash, date, author, subject: rest.join("\t") };
    });
}

export type DiffMode = "stat" | "patch";

export interface DiffOptions {
  base?: string;
  path?: string;
  mode: DiffMode;
  contextLines: number;
}

/** Diff the working tree against a base revision (defaults to HEAD). */
export async function gitDiff(repo: string, options: DiffOptions): Promise<string> {
  const base = assertSafeRef(options.base ?? "HEAD", "base");
  const args = ["diff", "--no-color", "--no-ext-diff"];
  if (options.mode === "stat") {
    args.push("--stat");
  } else {
    args.push("-U" + String(options.contextLines));
  }
  args.push(base, "--");
  if (options.path) {
    args.push(assertSafePath(options.path));
  }
  const stdout = await runGit(repo, args);
  return stdout.trim().length > 0 ? stdout : "(no changes against " + base + ")";
}
