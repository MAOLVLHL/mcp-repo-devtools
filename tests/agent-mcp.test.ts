import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runDiagnose } from "../src/agent/diagnose.js";
import type { AgentEvent } from "../src/agent/loop.js";
import { callTool, connectInProcess } from "../src/agent/mcp-tools.js";
import { ScriptedProvider } from "../src/agent/provider.js";

const gitAvailable = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

function makeRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "repo-devtools-agent-"));
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

test("exposes exactly the read-only tools the server advertises", async () => {
  const server = await connectInProcess({});
  try {
    assert.deepEqual(
      server.specs.map((spec) => spec.name).sort(),
      ["gh_ci_failures", "gh_issue_search", "gh_pr_context", "git_diff", "git_log", "git_status"],
    );
    for (const spec of server.specs) {
      assert.ok(spec.description.length > 0, spec.name + " has a description");
      assert.equal(spec.inputSchema.type, "object");
    }
  } finally {
    await server.close();
  }
});

test("calls a real tool against a local repository", { skip: !gitAvailable }, async () => {
  const repo = makeRepo();
  const server = await connectInProcess({ allowedRoots: [repo] });
  try {
    const outcome = await callTool(server.client, {
      id: "c1",
      name: "git_log",
      arguments: { repo, limit: 3 },
    });
    assert.equal(outcome.isError, false);
    assert.match(outcome.text, /feat: first commit/);

    const clipped = await callTool(server.client, { id: "c2", name: "git_log", arguments: { repo } }, 40);
    assert.ok(Buffer.byteLength(clipped.text, "utf8") < 400);
  } finally {
    await server.close();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("turns an unknown tool into a tool error", async () => {
  const server = await connectInProcess({});
  try {
    const outcome = await callTool(server.client, { id: "c1", name: "git_nope", arguments: {} });
    assert.equal(outcome.isError, true);
    assert.match(outcome.text, /not found/);
  } finally {
    await server.close();
  }
});

test("does not run a call whose arguments failed to parse", async () => {
  const server = await connectInProcess({});
  try {
    const outcome = await callTool(server.client, {
      id: "c1",
      name: "git_log",
      arguments: {},
      argumentsError: "arguments were not valid JSON: {oops",
    });
    assert.equal(outcome.isError, true);
    assert.match(outcome.text, /not executed/i);
    assert.match(outcome.text, /not valid JSON/);
  } finally {
    await server.close();
  }
});

test("runs the diagnose task end to end with a scripted model", { skip: !gitAvailable }, async () => {
  const repo = makeRepo();
  const provider = new ScriptedProvider([
    {
      text: "Checking history.",
      toolCalls: [{ id: "c1", name: "git_log", arguments: { repo, limit: 5 } }],
    },
    { text: "Report: the run failed on a flaky test.", toolCalls: [] },
  ]);
  const events: AgentEvent[] = [];

  try {
    const run = await runDiagnose({
      provider,
      target: { repo: "acme/widget", ref: "main", worktree: repo },
      server: { allowedRoots: [repo] },
      onEvent: (event) => events.push(event),
    });

    assert.equal(run.stopReason, "final");
    assert.equal(run.text, "Report: the run failed on a flaky test.");
    assert.equal(run.toolCalls, 1);
    assert.deepEqual(
      events.map((event) => event.type),
      ["turn", "tool", "result", "turn", "final"],
    );

    const toolMessage = run.messages.find((message) => message.role === "tool");
    assert.match(toolMessage?.role === "tool" ? toolMessage.text : "", /feat: first commit/);

    const first = provider.requests[0];
    assert.match(first?.system ?? "", /read-only/);
    const task = first?.messages[0];
    assert.equal(task?.role, "user");
    assert.match(task?.role === "user" ? task.text : "", /Repository: acme\/widget/);
    assert.match(task?.role === "user" ? task.text : "", /Local worktree/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
