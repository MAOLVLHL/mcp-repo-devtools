import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "../src/server.js";
import { makeZip } from "./zipfixture.js";

type RouteHandler = (signal: AbortSignal | undefined) => Response | Promise<Response>;

interface StubCall {
  url: string;
  signal: AbortSignal | undefined;
}

interface Stub {
  calls: StubCall[];
  restore(): void;
}

/** Replace global fetch with a router, so no test ever touches the network. */
function stubFetch(routes: Array<[RegExp, RouteHandler]>): Stub {
  const calls: StubCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const signal = init?.signal ?? undefined;
    calls.push({ url, signal });
    for (const [pattern, handler] of routes) {
      if (pattern.test(url)) {
        return handler(signal);
      }
    }
    throw new Error("unexpected fetch: " + url);
  }) as typeof fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function logArchive(): Buffer {
  return makeZip([
    { name: "1_test.txt", content: "2026-01-01T00:00:00.0000000Z running tests\n2026-01-01T00:00:01.0000000Z 1 failing\n" },
  ]);
}

function ciRoutes(): Array<[RegExp, RouteHandler]> {
  return [
    [
      /\/commits\/main\/check-runs/,
      () =>
        json({
          total_count: 3,
          check_runs: [
            {
              name: "test (ubuntu-latest, 20)",
              status: "completed",
              conclusion: "failure",
              details_url: "https://github.com/acme/widget/actions/runs/1001/job/5001",
              head_sha: "abc123",
              output: { title: "tests failed", summary: "1 failing" },
            },
            {
              name: "test (windows-latest, 22)",
              status: "completed",
              conclusion: "failure",
              details_url: "https://github.com/acme/widget/actions/runs/1002/job/5002",
              head_sha: "abc123",
              output: { title: "tests failed", summary: "2 failing" },
            },
            {
              name: "package",
              status: "completed",
              conclusion: "success",
              details_url: "https://github.com/acme/widget/actions/runs/1003/job/5003",
              head_sha: "abc123",
            },
          ],
        }),
    ],
    [
      /\/actions\/runs\/1001\/jobs/,
      () =>
        json({
          jobs: [
            { id: 5001, name: "test", conclusion: "failure", steps: [{ name: "run tests", conclusion: "failure" }] },
          ],
        }),
    ],
    [
      /\/actions\/runs\/1002\/jobs/,
      () =>
        json({
          jobs: [
            { id: 5002, name: "test", conclusion: "failure", steps: [{ name: "run tests", conclusion: "failure" }] },
          ],
        }),
    ],
    [
      /\/actions\/jobs\/5001\/logs/,
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://blob.example.test/5001" },
        }),
    ],
    [
      /\/actions\/jobs\/5002\/logs/,
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://blob.example.test/5002" },
        }),
    ],
    [/blob\.example\.test\//, () => new Response(logArchive(), { status: 200 })],
  ];
}

interface ToolResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

function textOf(result: ToolResult): string {
  return (result.content ?? []).map((part) => part.text ?? "").join("");
}

async function withClient(run: (client: Client) => Promise<void>): Promise<void> {
  const server = createServer({ allowedRoots: [process.cwd()], token: "test-token", enableWrite: false });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "progress", version: "0.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  try {
    await run(client);
  } finally {
    await client.close();
  }
}

test("gh_ci_failures reports one progress notification per GitHub hop", async () => {
  const stub = stubFetch(ciRoutes());
  const seen: Array<{ progress: number; total?: number; message?: string }> = [];
  try {
    await withClient(async (client) => {
      const result = (await client.callTool(
        { name: "gh_ci_failures", arguments: { repo: "acme/widget", ref: "main", include_logs: true } },
        undefined,
        { onprogress: (progress) => seen.push(progress) },
      )) as ToolResult;

      assert.equal(result.isError, undefined);
    });
  } finally {
    stub.restore();
  }

  // check runs, then one lookup and one download for each of the two failing checks.
  assert.equal(seen.length, 6);
  assert.deepEqual(
    seen.map((event) => event.progress),
    [0, 1, 2, 3, 4, 5],
  );
  assert.equal(seen[0]?.total, undefined);
  assert.match(seen[0]?.message ?? "", /check runs for main/);
  assert.match(seen[1]?.message ?? "", /2 failing check\(s\)/);
  assert.match(seen[2]?.message ?? "", /jobs for run 1001/);
  assert.match(seen[3]?.message ?? "", /log for job 5001/);
  assert.match(seen[4]?.message ?? "", /jobs for run 1002/);
  assert.match(seen[5]?.message ?? "", /log for job 5002/);
  assert.equal(seen.at(-1)?.progress, seen.at(-1)?.total);
});

test("a client without a progressToken gets the same answer as before", async () => {
  const stub = stubFetch(ciRoutes());
  try {
    await withClient(async (client) => {
      const withProgress = (await client.callTool(
        { name: "gh_ci_failures", arguments: { repo: "acme/widget", ref: "main", include_logs: true } },
        undefined,
        { onprogress: () => {} },
      )) as ToolResult;
      const withoutProgress = (await client.callTool({
        name: "gh_ci_failures",
        arguments: { repo: "acme/widget", ref: "main", include_logs: true },
      })) as ToolResult;

      assert.equal(textOf(withoutProgress), textOf(withProgress));
      assert.deepEqual(withoutProgress.structuredContent, withProgress.structuredContent);
    });
  } finally {
    stub.restore();
  }
});

test("cancelling the request aborts the underlying fetch", async () => {
  let observed: AbortSignal | undefined;
  const stub = stubFetch([
    [
      /\/pulls\/7/,
      (signal) => {
        observed = signal;
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        });
      },
    ],
  ]);

  try {
    await withClient(async (client) => {
      const controller = new AbortController();
      const call = client.callTool(
        { name: "gh_pr_context", arguments: { repo: "acme/widget", number: 7 } },
        undefined,
        { signal: controller.signal },
      );

      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(observed?.aborted, false);
      controller.abort();

      await assert.rejects(call);
      assert.equal(observed?.aborted, true);
    });
  } finally {
    stub.restore();
  }
});
