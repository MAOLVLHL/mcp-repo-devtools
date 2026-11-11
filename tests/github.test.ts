import assert from "node:assert/strict";
import test from "node:test";
import {
  assertRepoName,
  ciFailures,
  prContext,
  resolveToken,
  searchIssues,
} from "../src/github.js";

interface StubRoute {
  match: RegExp;
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
}

const originalFetch = globalThis.fetch;

function stubFetch(routes: StubRoute[]): Array<{ url: string; headers: Record<string, string> }> {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, headers });
    const route = routes.find((candidate) => candidate.match.test(url));
    if (!route) {
      throw new Error("unexpected fetch: " + url);
    }
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: route.headers,
    });
  }) as typeof fetch;
  return calls;
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("resolveToken prefers GITHUB_TOKEN, falls back to GH_TOKEN, ignores blanks", () => {
  assert.equal(resolveToken({ GITHUB_TOKEN: " ghp_x " }), "ghp_x");
  assert.equal(resolveToken({ GH_TOKEN: "gho_y" }), "gho_y");
  assert.equal(resolveToken({ GITHUB_TOKEN: "   " }), null);
  assert.equal(resolveToken({}), null);
});

test("assertRepoName accepts owner/name and rejects everything else", () => {
  assert.equal(assertRepoName("emcie-co/parlant"), "emcie-co/parlant");
  assert.throws(() => assertRepoName("parlant"), /owner\/name/);
  assert.throws(() => assertRepoName("../etc/passwd"), /owner\/name/);
  assert.throws(() => assertRepoName("a/b/c"), /owner\/name/);
});

test("searchIssues builds a scoped query and filters out pull requests", async () => {
  const calls = stubFetch([
    {
      match: /\/search\/issues\?/,
      body: {
        total_count: 2,
        items: [
          {
            number: 12,
            title: "SSE drops frames",
            state: "open",
            html_url: "https://github.com/o/r/issues/12",
            updated_at: "2026-11-01T10:00:00Z",
            body: "When the client reconnects,\nframes are lost.",
            labels: [{ name: "bug" }, "help wanted"],
          },
          {
            number: 13,
            title: "a pull request",
            state: "open",
            html_url: "https://github.com/o/r/pull/13",
            updated_at: "2026-11-01T10:00:00Z",
            body: null,
            labels: [],
            pull_request: { url: "x" },
          },
        ],
      },
    },
  ]);

  const result = await searchIssues(
    { repo: "o/r", query: "sse timeout", state: "open", limit: 5 },
    "ghp_test",
  );

  assert.equal(result.totalCount, 2);
  assert.equal(result.items.length, 1);
  assert.deepEqual(result.items[0]?.labels, ["bug", "help wanted"]);
  assert.equal(result.items[0]?.bodyExcerpt, "When the client reconnects, frames are lost.");

  const url = calls[0]?.url ?? "";
  assert.match(url, /repo%3Ao%2Fr/);
  assert.match(url, /is%3Aissue/);
  assert.match(url, /state%3Aopen/);
  assert.match(url, /per_page=5/);
  assert.equal(calls[0]?.headers["Authorization"], "Bearer ghp_test");
});

test("searchIssues omits the Authorization header without a token", async () => {
  const calls = stubFetch([{ match: /\/search\/issues/, body: { total_count: 0, items: [] } }]);
  await searchIssues({ repo: "o/r", query: "", state: "all", limit: 3 }, null);
  assert.equal(calls[0]?.headers["Authorization"], undefined);
});

test("an exhausted rate limit produces an actionable message", async () => {
  stubFetch([
    {
      match: /\/search\/issues/,
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1700000000" },
      body: { message: "API rate limit exceeded" },
    },
  ]);
  await assert.rejects(
    () => searchIssues({ repo: "o/r", query: "x", state: "open", limit: 3 }, null),
    /rate limit exhausted; resets at .* Set GITHUB_TOKEN/,
  );
});

test("a missing repository yields a 404 explanation", async () => {
  stubFetch([{ match: /\/pulls\/5(\/|$)/, status: 404, body: { message: "Not Found" } }]);
  await assert.rejects(() => prContext("o/r", 5, null), /404/);
});

test("ciFailures extracts failed steps from the workflow jobs API", async () => {
  stubFetch([
    {
      match: /\/commits\/main\/check-runs/,
      body: {
        total_count: 2,
        check_runs: [
          {
            name: "build",
            status: "completed",
            conclusion: "success",
            details_url: "https://github.com/o/r/actions/runs/98/job/1",
            head_sha: "abc123def456",
            output: { title: "ok", summary: "" },
          },
          {
            name: "test (ubuntu)",
            status: "completed",
            conclusion: "failure",
            details_url: "https://github.com/o/r/actions/runs/99/job/2",
            head_sha: "abc123def456",
            output: { title: "pytest failed", summary: "2 failed, 10 passed" },
          },
        ],
      },
    },
    {
      match: /\/actions\/runs\/99\/jobs/,
      body: {
        jobs: [
          {
            name: "test (ubuntu)",
            conclusion: "failure",
            steps: [
              { name: "checkout", conclusion: "success" },
              { name: "pytest", conclusion: "failure" },
            ],
          },
        ],
      },
    },
  ]);

  const report = await ciFailures("o/r", "main", null);
  assert.equal(report.checkedRuns, 2);
  assert.equal(report.failures.length, 1);
  assert.equal(report.sha, "abc123def456");
  assert.deepEqual(report.failures[0]?.failedSteps, ["test (ubuntu) / pytest"]);
  assert.equal(report.failures[0]?.summary, "2 failed, 10 passed");
});

test("prContext merges pull, files, reviews and comments", async () => {
  stubFetch([
    {
      match: /\/pulls\/7$/,
      body: {
        number: 7,
        title: "feat(api): resumable streams",
        state: "open",
        draft: false,
        user: { login: "author" },
        base: { ref: "develop" },
        head: { ref: "feat/x" },
        additions: 120,
        deletions: 4,
        changed_files: 2,
        body: "Adds Last-Event-ID support.",
      },
    },
    {
      match: /\/pulls\/7\/files/,
      body: [
        { filename: "src/a.py", status: "modified", additions: 100, deletions: 4 },
        { filename: "tests/test_a.py", status: "added", additions: 20, deletions: 0 },
      ],
    },
    {
      match: /\/pulls\/7\/reviews/,
      body: [{ user: { login: "reviewer" }, state: "CHANGES_REQUESTED", body: "please test reconnects" }],
    },
    {
      match: /\/pulls\/7\/comments/,
      body: [{ path: "src/a.py", line: 12, user: { login: "reviewer" }, body: "off by one" }],
    },
  ]);

  const context = await prContext("o/r", 7, "ghp_test");
  assert.equal(context.title, "feat(api): resumable streams");
  assert.equal(context.base, "develop");
  assert.equal(context.files.length, 2);
  assert.equal(context.reviews[0]?.state, "CHANGES_REQUESTED");
  assert.equal(context.comments[0]?.line, 12);
});
