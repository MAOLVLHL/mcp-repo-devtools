import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runDiagnose } from "../src/agent/diagnose.js";
import { OpenAIProvider } from "../src/agent/provider.js";

const gitAvailable = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

interface FakeEndpoint {
  baseUrl: string;
  requests: Array<Record<string, any>>;
  close(): Promise<void>;
}

/** A real HTTP server that answers /chat/completions with queued bodies. */
async function fakeOpenAI(replies: unknown[]): Promise<FakeEndpoint> {
  const requests: Array<Record<string, any>> = [];
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      requests.push(JSON.parse(body.length > 0 ? body : "{}") as Record<string, any>);
      const reply = replies.shift();
      if (reply === undefined) {
        response.writeHead(500, { "content-type": "text/plain" });
        response.end("no more replies queued");
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = address !== null && typeof address === "object" ? address.port : 0;
  return {
    baseUrl: "http://127.0.0.1:" + String(port) + "/v1",
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function makeRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "repo-devtools-openai-"));
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

test("drives the loop against an OpenAI-compatible endpoint over real HTTP", { skip: !gitAvailable }, async () => {
  const repo = makeRepo();
  const endpoint = await fakeOpenAI([
    {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { id: "c1", function: { name: "git_log", arguments: JSON.stringify({ repo, limit: 5 }) } },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 300, completion_tokens: 40 },
    },
    {
      choices: [
        {
          message: {
            content: "## What failed\nThe test job failed.\n\n## Why\nA commit changed src/a.ts.",
          },
        },
      ],
      usage: { prompt_tokens: 400, completion_tokens: 60 },
    },
  ]);

  try {
    const provider = new OpenAIProvider({ apiKey: "sk-test", baseUrl: endpoint.baseUrl });
    const run = await runDiagnose({
      provider,
      target: { repo: "acme/widget", ref: "main", worktree: repo },
      server: { allowedRoots: [repo] },
    });

    assert.equal(run.stopReason, "final");
    assert.match(run.text, /^## What failed/);
    assert.equal(run.toolCalls, 1);
    assert.deepEqual(run.usage, { input: 700, output: 100 });

    assert.equal(endpoint.requests.length, 2);
    const first = endpoint.requests[0];
    assert.equal(first?.model, "gpt-4o-mini");
    assert.equal((first?.tools as unknown[]).length, 6);
    assert.equal(first?.tool_choice, "auto");

    const second = endpoint.requests[1];
    const messages = second?.messages as Array<Record<string, any>>;
    const toolResult = messages.find((message) => message.role === "tool");
    assert.ok(toolResult !== undefined);
    assert.match(String(toolResult?.content), /feat: first commit/);
    assert.equal(toolResult?.tool_call_id, "c1");
  } finally {
    await endpoint.close();
    rmSync(repo, { recursive: true, force: true });
  }
});
