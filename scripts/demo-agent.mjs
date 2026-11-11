#!/usr/bin/env node
/**
 * Manual demo of the reference agent: a scripted model, a real MCP server and a
 * real git repository, no API key and no network.
 *
 *   npm run build && node scripts/demo-agent.mjs
 *
 * The first turn asks for a GitHub tool on purpose: fetch is stubbed to fail,
 * so the run shows what the loop does with an error result, then falls back to
 * the local history tool and finishes with a report.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { runDiagnose } from "../dist/agent/diagnose.js";
import { describeRun } from "../dist/agent/loop.js";
import { ScriptedProvider } from "../dist/agent/provider.js";

function gitAvailable() {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "repo-devtools-demo-"));
  const g = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "demo@example.com");
  g("config", "user.name", "Demo");
  g("config", "commit.gpgsign", "false");
  mkdirSync(path.join(dir, "src"));
  writeFileSync(path.join(dir, "src", "a.ts"), "export const a = 1;\n");
  g("add", ".");
  g("commit", "-q", "-m", "feat: first commit");
  writeFileSync(path.join(dir, "src", "a.ts"), "export const a = 2;\n");
  g("add", ".");
  g("commit", "-q", "-m", "fix: change a to 2");
  return dir;
}

let created = null;
let worktree = process.cwd();
if (!existsSync(path.join(worktree, ".git"))) {
  if (!gitAvailable()) {
    process.stderr.write("This demo needs git and a git working tree.\n");
    process.exit(1);
  }
  created = makeRepo();
  worktree = created;
}

// Offline by construction: every GitHub request fails fast with a clear message.
globalThis.fetch = async (input) => {
  throw new Error("the demo is offline, so this GitHub request was refused: " + String(input));
};

const provider = new ScriptedProvider([
  {
    text: "Start with the failing checks.",
    toolCalls: [{ id: "c1", name: "gh_ci_failures", arguments: { repo: "acme/widget", ref: "main" } }],
  },
  {
    text: "GitHub is unreachable here; read the local history instead.",
    toolCalls: [{ id: "c2", name: "git_log", arguments: { repo: worktree, limit: 5 } }],
  },
  (request) => {
    const last = [...request.messages].reverse().find((message) => message.role === "tool");
    const text = last && last.role === "tool" ? last.text : "";
    const lines = text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
    const firstCommit = lines.find((line) => /^[0-9a-f]{7,}\b/.test(line)) ?? lines[0] ?? "no commits found";
    return {
      text: [
        "## What failed",
        "The scripted demo stops before naming a real job; a live model would quote one.",
        "",
        "## Why",
        "Local history it actually read:",
        "",
        "    " + firstCommit,
        "",
        "## Introduced by",
        "Unknown in the demo. The loop only reports what a tool showed it.",
        "",
        "## Next step",
        "Run the same command with OPENAI_API_KEY and GITHUB_TOKEN set for a real diagnosis.",
      ].join("\n"),
      toolCalls: [],
    };
  },
]);

function formatBytes(bytes) {
  return bytes >= 1024 ? (bytes / 1024).toFixed(1) + " KB" : String(bytes) + " B";
}

try {
  const run = await runDiagnose({
    provider,
    target: { repo: "acme/widget", ref: "main", worktree },
    // The git tools refuse to read outside the roots this server is allowed.
    server: { allowedRoots: [worktree] },
    limits: { maxTurns: 6 },
    onEvent: (event) => {
      if (event.type === "turn") {
        process.stderr.write("[turn " + event.turn + "]\n");
      } else if (event.type === "tool") {
        process.stderr.write("  -> " + event.name + " " + JSON.stringify(event.arguments) + "\n");
      } else if (event.type === "result") {
        process.stderr.write("  <- " + (event.isError ? "error" : "ok") + " " + formatBytes(event.bytes) + "\n");
      }
    },
  });
  process.stdout.write(run.text + "\n");
  process.stderr.write(describeRun(run) + "\n");
  process.stderr.write("worktree: " + worktree + "\n");
} finally {
  if (created !== null) {
    rmSync(created, { recursive: true, force: true });
  }
}
