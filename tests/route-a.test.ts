import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CreateMessageRequestSchema,
  ElicitRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import type { ServerOptions } from "../src/server.js";
import { createServer } from "../src/server.js";

interface Harness {
  client: Client;
  close(): Promise<void>;
}

/** A connected client whose declared capabilities the test chooses. */
async function connect(
  options: ServerOptions,
  capabilities: Record<string, unknown>,
): Promise<Harness> {
  const server = createServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "route-a-test", version: "1.0.0" }, { capabilities });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Replace fetch for one test; returns the urls that were actually requested. */
function stubFetch(handler: (url: string) => Response): { urls: string[]; restore(): void } {
  const urls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    return handler(url);
  }) as typeof fetch;
  return {
    urls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

interface BigRepo {
  dir: string;
  cleanup(): void;
}

/** A repository whose unstaged diff is far larger than the 64 KB budget. */
function bigRepo(): BigRepo {
  const dir = mkdtempSync(join(tmpdir(), "repo-devtools-route-a-"));
  const git = (...args: string[]): void => {
    execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
  };
  const lines = (marker: string): string =>
    Array.from({ length: 3000 }, (_, i) => marker + " line " + String(i) + " of a long file").join("\n") + "\n";
  execFileSync("git", ["init", "-b", "main", dir], { stdio: "pipe" });
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "big.txt"), lines("before"));
  git("add", "-A");
  git("commit", "-m", "init");
  writeFileSync(join(dir, "big.txt"), lines("after"));
  return {
    dir,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("lists the three workflow prompts", async () => {
  const harness = await connect({}, {});
  try {
    const listed = await harness.client.listPrompts();
    const names = listed.prompts.map((prompt) => prompt.name).sort();
    assert.deepEqual(names, ["diagnose-ci", "review-pr", "triage-issues"]);
    for (const prompt of listed.prompts) {
      assert.ok(prompt.description && prompt.description.length > 0, prompt.name + " has no description");
      assert.ok((prompt.arguments ?? []).length > 0, prompt.name + " declares no arguments");
    }
  } finally {
    await harness.close();
  }
});

test("renders a prompt with the arguments the caller passed", async () => {
  const harness = await connect({}, {});
  try {
    const result = await harness.client.getPrompt({
      name: "diagnose-ci",
      arguments: { repo: "acme/widget", ref: "main" },
    });
    assert.equal(result.messages.length, 1);
    const message = result.messages[0];
    assert.ok(message);
    assert.equal(message.role, "user");
    assert.equal(message.content.type, "text");
    const text = message.content.type === "text" ? message.content.text : "";
    assert.match(text, /acme\/widget/);
    assert.match(text, /"main"/);
    assert.match(text, /Do not edit files/);
  } finally {
    await harness.close();
  }
});

test("asks the client before opening a pull request", async () => {
  const prompts: string[] = [];
  const fetchStub = stubFetch(() => json({ number: 12, draft: false, title: "T", html_url: "https://x/12" }));
  const harness = await connect(
    { enableWrite: true, token: "ghp_test" },
    { elicitation: {} },
  );
  harness.client.setRequestHandler(ElicitRequestSchema, async (request) => {
    prompts.push(request.params.message);
    return { action: "accept", content: { approve: true } };
  });
  try {
    const result = await harness.client.callTool({
      name: "gh_pr_create",
      arguments: { repo: "acme/widget", title: "Add a flag", head: "feat/flag", base: "main" },
    });
    assert.equal(result.isError, undefined);
    assert.match(textOf(result as { content: Array<{ type: string; text?: string }> }), /opened PR #12/);
    assert.equal(prompts.length, 1);
    assert.match(prompts[0] ?? "", /Open a pull request/);
    assert.match(prompts[0] ?? "", /feat\/flag -> main/);
    assert.equal(fetchStub.urls.length, 1);
  } finally {
    await harness.close();
    fetchStub.restore();
  }
});

test("sends nothing when the human declines", async () => {
  const fetchStub = stubFetch(() => json({}));
  const harness = await connect({ enableWrite: true, token: "ghp_test" }, { elicitation: {} });
  harness.client.setRequestHandler(ElicitRequestSchema, async () => ({
    action: "decline",
    content: { approve: false, note: "not this week" },
  }));
  try {
    const result = await harness.client.callTool({
      name: "gh_issue_create",
      arguments: { repo: "acme/widget", title: "Bug report" },
    });
    assert.equal(result.isError, true);
    const text = textOf(result as { content: Array<{ type: string; text?: string }> });
    assert.match(text, /not approved \(declined\)/);
    assert.match(text, /not this week/);
    assert.equal(fetchStub.urls.length, 0);
  } finally {
    await harness.close();
    fetchStub.restore();
  }
});

test("fails closed when confirmation is required and the client cannot ask", async () => {
  const fetchStub = stubFetch(() => json({}));
  const harness = await connect({ enableWrite: true, token: "ghp_test", confirmWrites: true }, {});
  try {
    const result = await harness.client.callTool({
      name: "gh_pr_comment",
      arguments: { repo: "acme/widget", number: 3, body: "hello" },
    });
    assert.equal(result.isError, true);
    assert.match(textOf(result as { content: Array<{ type: string; text?: string }> }), /not approved \(unsupported\)/);
    assert.equal(fetchStub.urls.length, 0);
  } finally {
    await harness.close();
    fetchStub.restore();
  }
});

test("does not block a write when the client cannot ask and confirmation is optional", async () => {
  const fetchStub = stubFetch((url) =>
    url.endsWith("/issues")
      ? json({ number: 7, title: "Bug report", html_url: "https://x/7" })
      : json({}),
  );
  const harness = await connect({ enableWrite: true, token: "ghp_test" }, {});
  try {
    const result = await harness.client.callTool({
      name: "gh_issue_create",
      arguments: { repo: "acme/widget", title: "Bug report" },
    });
    assert.equal(result.isError, undefined);
    assert.match(textOf(result as { content: Array<{ type: string; text?: string }> }), /filed issue #7/);
    assert.equal(fetchStub.urls.length, 1);
  } finally {
    await harness.close();
    fetchStub.restore();
  }
});

test("summarises an over-budget result instead of clipping it", async () => {
  const repo = bigRepo();
  const harness = await connect({ allowedRoots: [repo.dir], compressOutput: true }, { sampling: {} });
  harness.client.setRequestHandler(CreateMessageRequestSchema, async () => ({
    model: "test-model",
    role: "assistant",
    content: { type: "text", text: "The diff renames before to after in 3000 lines." },
  }));
  try {
    const result = await harness.client.callTool({
      name: "git_diff",
      arguments: { repo: repo.dir, mode: "patch" },
    });
    assert.equal(result.isError, undefined);
    const text = textOf(result as { content: Array<{ type: string; text?: string }> });
    assert.match(text, /^\u2026compressed from \d+ bytes by the client model/);
    assert.match(text, /3000 lines/);
    assert.ok(!text.includes("\u2026truncated"), "a compressed result should not also be clipped");
  } finally {
    await harness.close();
    repo.cleanup();
  }
});

test("falls back to the clip when the client's model fails", async () => {
  const repo = bigRepo();
  const harness = await connect({ allowedRoots: [repo.dir], compressOutput: true }, { sampling: {} });
  harness.client.setRequestHandler(CreateMessageRequestSchema, async () => {
    throw new Error("model unavailable");
  });
  try {
    const result = await harness.client.callTool({
      name: "git_diff",
      arguments: { repo: repo.dir, mode: "patch" },
    });
    assert.equal(result.isError, undefined);
    const text = textOf(result as { content: Array<{ type: string; text?: string }> });
    assert.match(text, /\u2026truncated \(\d+ more lines/);
    assert.ok(!text.startsWith("\u2026compressed"));
    assert.ok(Buffer.byteLength(text, "utf8") <= 64 * 1024);
  } finally {
    await harness.close();
    repo.cleanup();
  }
});

test("leaves a result inside the budget byte-identical", async () => {
  const repo = bigRepo();
  const harness = await connect({ allowedRoots: [repo.dir], compressOutput: true }, { sampling: {} });
  let sampled = 0;
  harness.client.setRequestHandler(CreateMessageRequestSchema, async () => {
    sampled += 1;
    return { model: "test-model", role: "assistant", content: { type: "text", text: "unused" } };
  });
  try {
    const plain = await connect({ allowedRoots: [repo.dir] }, {});
    const baseline = await plain.client.callTool({ name: "git_status", arguments: { repo: repo.dir } });
    await plain.close();
    const result = await harness.client.callTool({ name: "git_status", arguments: { repo: repo.dir } });
    assert.equal(
      textOf(result as { content: Array<{ type: string; text?: string }> }),
      textOf(baseline as { content: Array<{ type: string; text?: string }> }),
    );
    assert.equal(sampled, 0, "a result that fits must not be sent to the model");
  } finally {
    await harness.close();
    repo.cleanup();
  }
});
