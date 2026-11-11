#!/usr/bin/env node
/**
 * Measures what the tools actually return against what an agent would get by
 * running the obvious command itself. Every number in docs/measurements.md and
 * the README comes from this script; none of them are estimates.
 *
 * Usage:
 *   node bench/measure.mjs --repo /path/to/checkout [--gh owner/name]
 *                          [--ci-repo owner/name] [--json out.json]
 *
 * Run "npm run build" first: the client talks to dist/index.js over stdio, so
 * the measurement includes the real JSON-RPC round trip.
 */

import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, "..", "dist", "index.js");

function arg(name, fallback) {
  const index = process.argv.indexOf("--" + name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const repo = arg("repo", process.cwd());
const ghRepo = arg("gh", "HKUDS/nanobot");
const ciRepo = arg("ci-repo", "HKUDS/nanobot");
const jsonOut = arg("json", join(here, "results", "latest.json"));
const token = process.env.GITHUB_TOKEN ?? null;

const bytes = (text) => Buffer.byteLength(text, "utf8");

async function sh(file, args, cwd) {
  const started = process.hrtime.bigint();
  try {
    const { stdout } = await run(file, args, { cwd, maxBuffer: 64 * 1024 * 1024 });
    return { text: stdout, ms: Number(process.hrtime.bigint() - started) / 1e6 };
  } catch (error) {
    return { text: String(error.stdout ?? error.message), ms: Number(process.hrtime.bigint() - started) / 1e6 };
  }
}

async function api(path) {
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "mcp-repo-devtools-bench" };
  if (token) headers.Authorization = "Bearer " + token;
  const started = process.hrtime.bigint();
  const response = await fetch("https://api.github.com" + path, { headers });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { text, status: response.status, json, ms: Number(process.hrtime.bigint() - started) / 1e6 };
}

/** A checkout with many dirty files, so the 200-entry cap is actually exercised. */
/** A repository with 60 commits, so git log and git diff have something to show. */
async function historyFixture() {
  const dir = await mkdtemp(join(tmpdir(), "repo-devtools-history-"));
  await run("git", ["init", "-q"], { cwd: dir });
  await run("git", ["config", "user.email", "bench@example.com"], { cwd: dir });
  await run("git", ["config", "user.name", "bench"], { cwd: dir });
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "app.js"), "export const routes = [];\n");
  await run("git", ["add", "-A"], { cwd: dir });
  await run("git", ["commit", "-qm", "chore: baseline"], { cwd: dir });
  for (let index = 0; index < 60; index += 1) {
    const body = Array.from({ length: 12 }, (_, line) => "export function handler" + String(index) + "_" + String(line) + "() { return " + String(line) + "; }").join("\n");
    await writeFile(join(dir, "src", "feature-" + String(index) + ".js"), body + "\n");
    await writeFile(join(dir, "src", "app.js"), "export const routes = [" + String(index) + "];\n");
    await run("git", ["add", "-A"], { cwd: dir });
    await run("git", ["commit", "-qm", "feat: add handler " + String(index)], { cwd: dir });
  }
  return dir;
}

async function busyFixture() {
  const dir = await mkdtemp(join(tmpdir(), "repo-devtools-bench-"));
  await run("git", ["init", "-q"], { cwd: dir });
  await run("git", ["config", "user.email", "bench@example.com"], { cwd: dir });
  await run("git", ["config", "user.name", "bench"], { cwd: dir });
  await mkdir(join(dir, "src"), { recursive: true });
  for (let index = 0; index < 400; index += 1) {
    await writeFile(join(dir, "src", "module-" + String(index) + ".js"), "export const value = 1;\n");
  }
  await run("git", ["add", "-A"], { cwd: dir });
  await run("git", ["commit", "-qm", "baseline"], { cwd: dir });
  for (let index = 0; index < 400; index += 1) {
    await writeFile(join(dir, "src", "module-" + String(index) + ".js"), "export const value = 2;\n");
  }
  await writeFile(
    join(dir, "src", "generated.js"),
    "export const table = [" + Array.from({ length: 4000 }, (_, i) => String(i)).join(", ") + "];\n",
  );
  return dir;
}

const cases = [];
function record(name, note, naive, tool) {
  const saved = naive.bytes > 0 ? 1 - tool.bytes / naive.bytes : 0;
  cases.push({
    name,
    note,
    naiveBytes: naive.bytes,
    toolBytes: tool.bytes,
    saved: Number(saved.toFixed(3)),
    naiveMs: Math.round(naive.ms),
    toolMs: Math.round(tool.ms),
  });
}

async function main() {
  const separator = process.platform === "win32" ? ";" : ":";
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: {
      ...process.env,
      MCP_ALLOWED_ROOTS: [repo, tmpdir()].join(separator),
      GITHUB_TOKEN: token ?? "",
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "bench", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);

  async function call(name, args) {
    const started = process.hrtime.bigint();
    const result = await client.callTool({ name, arguments: args });
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    const text = (result.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("\n");
    return { text, ms, isError: result.isError === true };
  }

  {
    const dir = await historyFixture();
    try {
      const naive = await sh("git", ["log", "-n", "20", "-p", "--format=%H %an %ad %s"], dir);
      const tool = await call("git_log", { repo: dir, limit: 20 });
      record("git_log", "fixture, 20 commits, git log -p", { bytes: bytes(naive.text), ms: naive.ms }, { bytes: bytes(tool.text), ms: tool.ms });

      const naiveDiff = await sh("git", ["diff", "HEAD~5"], dir);
      const toolDiff = await call("git_diff", { repo: dir, base: "HEAD~5" });
      record("git_diff", "fixture, HEAD~5 patch vs stat", { bytes: bytes(naiveDiff.text), ms: naiveDiff.ms }, { bytes: bytes(toolDiff.text), ms: toolDiff.ms });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  {
    const naive = await api("/search/issues?q=repo:" + ghRepo + "+is:issue&per_page=30&sort=updated");
    const tool = await call("gh_issue_search", { repo: ghRepo, limit: 10 });
    record("gh_issue_search", ghRepo + " raw JSON vs 10 issues", { bytes: bytes(naive.text), ms: naive.ms }, { bytes: bytes(tool.text), ms: tool.ms });
  }

  {
    const runs = await api("/repos/" + ciRepo + "/actions/runs?status=failure&per_page=1");
    const failingRun = runs.json?.workflow_runs?.[0];
    const runId = failingRun?.id;
    const runSha = failingRun?.head_sha;
    const jobList = runId ? await api("/repos/" + ciRepo + "/actions/runs/" + String(runId) + "/jobs") : null;
    const failedJobs = (jobList?.json?.jobs ?? [])
      .filter((job) => job.conclusion && job.conclusion !== "success" && job.conclusion !== "skipped" && job.conclusion !== "neutral")
      .slice(0, 3);
    if (runId && failedJobs.length > 0) {
      // Fair baseline: the full log of the same jobs the tool reads, not just the first one.
      let naiveBytes = 0;
      let naiveMs = 0;
      for (const job of failedJobs) {
        const log = await api("/repos/" + ciRepo + "/actions/jobs/" + String(job.id) + "/logs");
        naiveBytes += bytes(log.text);
        naiveMs += log.ms;
      }
      const tool = await call("gh_ci_failures", { repo: ciRepo, ref: String(runSha), include_logs: true, log_lines: 40 });
      record(
        "gh_ci_failures",
        ciRepo + " run " + String(runId) + ", " + String(failedJobs.length) + " failed job(s)",
        { bytes: naiveBytes, ms: naiveMs },
        { bytes: bytes(tool.text), ms: tool.ms },
      );
    }
  }

  {
    const dir = await busyFixture();
    try {
      const naive = await sh("git", ["status", "--porcelain=v1", "-b", "--untracked-files=all"], dir);
      const tool = await call("git_status", { repo: dir });
      record("git_status", "fixture, 400 dirty files, cap at 200", { bytes: bytes(naive.text), ms: naive.ms }, { bytes: bytes(tool.text), ms: tool.ms });

      const naivePatch = await sh("git", ["diff", "HEAD"], dir);
      const toolStat = await call("git_diff", { repo: dir, base: "HEAD" });
      record("git_diff", "fixture, 400 dirty, patch vs stat", { bytes: bytes(naivePatch.text), ms: naivePatch.ms }, { bytes: bytes(toolStat.text), ms: toolStat.ms });

      const toolPatch = await call("git_diff", { repo: dir, base: "HEAD", mode: "patch" });
      record("git_diff", "fixture, patch mode cut by 64 KB / 200 line cap", { bytes: bytes(naivePatch.text), ms: naivePatch.ms }, { bytes: bytes(toolPatch.text), ms: toolPatch.ms });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  const probes = [];
  async function probe(name, toolName, args) {
    const result = await call(toolName, args);
    const refused = result.isError === true || /Error:|refused|outside|must not|not allowed|absolute/i.test(result.text);
    probes.push({ name, refused, sample: result.text.split("\n")[0].slice(0, 120) });
  }
  await probe("path outside MCP_ALLOWED_ROOTS", "git_status", { repo: join(repo, "..", "..") });
  await probe("ref that starts with -", "git_diff", { repo, base: "--output=/tmp/x" });
  await probe("shell metacharacters as a ref", "git_diff", { repo, base: "HEAD; echo pwned" });
  await probe("owner/name with spaces", "gh_issue_search", { repo: "not a repo" });

  const payload = {
    generatedAt: new Date().toISOString(),
    platform: process.platform + " " + process.arch,
    node: process.version,
    git: (await sh("git", ["--version"], repo)).text.trim(),
    repo,
    ghRepo,
    ciRepo,
    cases,
    probes,
  };

  await mkdir(dirname(jsonOut), { recursive: true });
  await writeFile(jsonOut, JSON.stringify(payload, null, 2) + "\n");

  const header = ["case", "naive B", "tool B", "saved", "naive ms", "tool ms"];
  const rows = cases.map((item) => [
    item.name + " - " + item.note,
    String(item.naiveBytes),
    String(item.toolBytes),
    (item.saved * 100).toFixed(1) + "%",
    String(item.naiveMs),
    String(item.toolMs),
  ]);
  const widths = header.map((cell, column) => Math.max(cell.length, ...rows.map((row) => row[column].length)));
  const line = (cells) =>
    cells.map((cell, column) => (column === 0 ? cell.padEnd(widths[column]) : cell.padStart(widths[column]))).join("  ");
  console.log(line(header));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) console.log(line(row));
  console.log("");
  for (const item of probes) console.log((item.refused ? "refused  " : "LEAKED   ") + item.name + "  [" + item.sample + "]");
  console.log("");
  console.log("saved = 1 - tool/naive; tokens at 4 bytes each");
  console.log("wrote " + jsonOut);

  await client.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});