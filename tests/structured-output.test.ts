import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "../src/server.js";
import { MAX_OUTPUT_BYTES } from "../src/text.js";

const gitAvailable = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

interface ToolResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

function textOf(result: ToolResult): string {
  return (result.content ?? []).map((part) => part.text ?? "").join("");
}

function makeRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "repo-devtools-structured-"));
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

async function withClient<T>(
  roots: string[],
  enableWrite: boolean,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const server = createServer({ allowedRoots: roots, token: null, enableWrite });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "structured", version: "0.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  try {
    return await run(client);
  } finally {
    await client.close();
  }
}

test(
  "git_status returns the working tree as fields, and the text is unchanged",
  { skip: !gitAvailable },
  async () => {
    const repo = makeRepo();
    writeFileSync(path.join(repo, "README.md"), "hello\nworld\n");
    try {
      await withClient([path.dirname(repo)], false, async (client) => {
        const result = (await client.callTool({
          name: "git_status",
          arguments: { repo },
        })) as ToolResult;

        assert.equal(result.isError, undefined);
        assert.deepEqual(result.structuredContent, {
          branch: "main",
          upstream: null,
          ahead: 0,
          behind: 0,
          changes: [{ status: "modified", path: "README.md" }],
          truncated: false,
        });
        assert.equal(textOf(result), "branch main  +0 -0\n1 changed path(s)\nmodified  README.md");
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  },
);

test("git_log parses commits into fields and keeps the rendered lines", { skip: !gitAvailable }, async () => {
  const repo = makeRepo();
  try {
    await withClient([path.dirname(repo)], false, async (client) => {
      const result = (await client.callTool({
        name: "git_log",
        arguments: { repo, limit: 5 },
      })) as ToolResult;

      const structured = result.structuredContent ?? {};
      const commits = structured["commits"] as Array<Record<string, string>>;
      assert.equal(structured["path"], null);
      assert.equal(commits.length, 1);
      assert.equal(commits[0]?.["subject"], "feat: initial commit");
      assert.equal(commits[0]?.["author"], "Test User");
      assert.match(commits[0]?.["date"] ?? "", /^\d{4}-\d{2}-\d{2}$/);
      assert.match(textOf(result), /feat: initial commit/);
    });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("an empty working tree yields empty arrays, not missing fields", { skip: !gitAvailable }, async () => {
  const repo = makeRepo();
  try {
    await withClient([path.dirname(repo)], false, async (client) => {
      const result = (await client.callTool({
        name: "git_status",
        arguments: { repo },
      })) as ToolResult;
      const structured = result.structuredContent ?? {};
      assert.deepEqual(structured["changes"], []);
      assert.equal(structured["truncated"], false);
      assert.equal(textOf(result), "branch main  +0 -0\n0 changed path(s)");
    });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a rejected repository is an error with no structured content", { skip: !gitAvailable }, async () => {
  const allowed = makeRepo();
  const outside = makeRepo();
  try {
    await withClient([allowed], false, async (client) => {
      const result = (await client.callTool({
        name: "git_status",
        arguments: { repo: outside },
      })) as ToolResult;
      assert.equal(result.isError, true);
      assert.match(textOf(result), /outside MCP_ALLOWED_ROOTS/);
      assert.equal(result.structuredContent, undefined);
    });
  } finally {
    rmSync(allowed, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("git_diff caps the structured patch and reports the cut", { skip: !gitAvailable }, async () => {
  const repo = makeRepo();
  const lines: string[] = [];
  for (let index = 0; index < 4000; index += 1) {
    lines.push("line " + String(index) + " " + "x".repeat(40));
  }
  writeFileSync(path.join(repo, "README.md"), lines.join("\n") + "\n");
  try {
    await withClient([path.dirname(repo)], false, async (client) => {
      const result = (await client.callTool({
        name: "git_diff",
        arguments: { repo, mode: "patch" },
      })) as ToolResult;
      const structured = result.structuredContent ?? {};
      const diff = structured["diff"] as string;
      assert.equal(structured["truncated"], true);
      assert.equal(structured["mode"], "patch");
      assert.match(diff, /truncated \(\d+ more lines; narrow with path= or lower context_lines=\)/);
      assert.ok(Buffer.byteLength(diff, "utf8") <= MAX_OUTPUT_BYTES + 256, "structured diff stays inside the budget");
      // The rendered text keeps the generic hint it has always printed; only the
      // structured copy names the argument that actually narrows a diff.
      assert.match(textOf(result), /narrow with path= or max_lines=/);
    });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a credential in a commit subject is redacted in the structured copy too", { skip: !gitAvailable }, async () => {
  const repo = makeRepo();
  const secret = "ghp_" + "0123456789abcdefghijklmnopqrstuvwx";
  try {
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "chore: rotate " + secret], {
      cwd: repo,
      stdio: "pipe",
    });
    await withClient([path.dirname(repo)], false, async (client) => {
      const result = (await client.callTool({
        name: "git_log",
        arguments: { repo, limit: 1 },
      })) as ToolResult;
      const commits = (result.structuredContent ?? {})["commits"] as Array<Record<string, string>>;
      assert.match(commits[0]?.["subject"] ?? "", /ghp_\*\*\*redacted\*\*\*/);
      assert.equal(textOf(result).includes(secret), false);
      assert.equal(JSON.stringify(result.structuredContent).includes(secret), false);
    });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("write tools keep the text-only result shape", { skip: !gitAvailable }, async () => {
  const repo = makeRepo();
  try {
    await withClient([path.dirname(repo)], true, async (client) => {
      const { tools } = await client.listTools();
      const writeTools = tools.filter((tool) =>
        ["gh_pr_create", "gh_issue_create", "gh_pr_comment"].includes(tool.name),
      );
      assert.equal(writeTools.length, 3);
      for (const tool of writeTools) {
        assert.equal(tool.outputSchema, undefined, tool.name + " must stay text-only");
      }
      const readTools = tools.filter((tool) => !writeTools.includes(tool));
      for (const tool of readTools) {
        assert.ok(tool.outputSchema, tool.name + " must declare its structured shape");
      }
    });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
