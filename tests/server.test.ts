import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ENTRY = path.resolve(import.meta.dirname, "..", "dist", "index.js");

const gitAvailable = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

function makeRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "repo-devtools-server-"));
  const g = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "test@example.com");
  g("config", "user.name", "Test User");
  g("config", "commit.gpgsign", "false");
  writeFileSync(path.join(dir, "README.md"), "hello\n");
  g("add", ".");
  g("commit", "-q", "-m", "feat: initial commit");
  return dir;
}

function childEnv(roots: string): Record<string, string> {
  const env: Record<string, string> = { MCP_ALLOWED_ROOTS: roots };
  for (const key of ["PATH", "HOME", "USERPROFILE", "SystemRoot", "TMP", "TEMP"]) {
    const value = process.env[key];
    if (value) {
      env[key] = value;
    }
  }
  return env;
}

async function withClient<T>(roots: string, run: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY],
    env: childEnv(roots),
    stderr: "pipe",
  });
  const client = new Client({ name: "repo-devtools-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    return await run(client);
  } finally {
    await client.close();
  }
}

function textOf(result: { content?: unknown; isError?: boolean }): string {
  const content = result.content as Array<{ type: string; text?: string }> | undefined;
  return (content ?? []).map((part) => part.text ?? "").join("");
}

test("the server advertises exactly the read-only tools", async () => {
  const repo = makeRepo();
  try {
    await withClient(path.dirname(repo), async (client) => {
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name).sort();
      assert.deepEqual(names, [
        "gh_ci_failures",
        "gh_issue_search",
        "gh_pr_context",
        "git_diff",
        "git_log",
        "git_status",
      ]);
      for (const tool of tools) {
        assert.ok(tool.description && tool.description.length > 40, tool.name + " needs a description");
      }
    });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("git_log works end to end over stdio", { skip: !gitAvailable }, async () => {
  const repo = makeRepo();
  try {
    await withClient(path.dirname(repo), async (client) => {
      const result = (await client.callTool({
        name: "git_log",
        arguments: { repo, limit: 5 },
      })) as { content?: unknown; isError?: boolean };
      assert.equal(result.isError, undefined);
      assert.match(textOf(result), /feat: initial commit/);
    });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a repository outside MCP_ALLOWED_ROOTS is rejected with a readable error", async () => {
  const allowed = makeRepo();
  const outside = makeRepo();
  try {
    await withClient(allowed, async (client) => {
      const result = (await client.callTool({
        name: "git_status",
        arguments: { repo: outside },
      })) as { content?: unknown; isError?: boolean };
      assert.equal(result.isError, true);
      assert.match(textOf(result), /outside MCP_ALLOWED_ROOTS/);
    });
  } finally {
    rmSync(allowed, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("git_diff surfaces the patch when asked for it", { skip: !gitAvailable }, async () => {
  const repo = makeRepo();
  try {
    writeFileSync(path.join(repo, "README.md"), "hello\nworld\n");
    await withClient(path.dirname(repo), async (client) => {
      const result = (await client.callTool({
        name: "git_diff",
        arguments: { repo, mode: "patch" },
      })) as { content?: unknown; isError?: boolean };
      assert.match(textOf(result), /\+world/);
    });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
