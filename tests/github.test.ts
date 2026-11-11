import assert from "node:assert/strict";
import test from "node:test";
import {
  assertRepoName,
  ciFailures,
  commentOnThread,
  createIssue,
  createPullRequest,
  prContext,
  resolveToken,
  searchIssues,
} from "../src/github.js";
import { makeZip } from "./zipfixture.js";

interface StubRoute {
  match: RegExp;
  status?: number;
  body?: unknown;
  binary?: Buffer;
  headers?: Record<string, string>;
}

interface StubCall {
  url: string;
  headers: Record<string, string>;
  method: string;
  body: string;
}

const originalFetch = globalThis.fetch;

function stubFetch(routes: StubRoute[]): StubCall[] {
  const calls: StubCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, headers, method: init?.method ?? "GET", body: String(init?.body ?? "") });
    const route = routes.find((candidate) => candidate.match.test(url));
    if (!route) {
      throw new Error("unexpected fetch: " + url);
    }
    if (route.binary) {
      return new Response(new Uint8Array(route.binary), {
        status: route.status ?? 200,
        headers: route.headers,
      });
    }
    return new Response(JSON.stringify(route.body ?? {}), {
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

const failingCheckRuns = {
  total_count: 1,
  check_runs: [
    {
      name: "test (ubuntu)",
      status: "completed",
      conclusion: "failure",
      details_url: "https://github.com/o/r/actions/runs/99/job/2",
      head_sha: "abc123def456",
      output: { title: "pytest failed", summary: "1 failed" },
    },
  ],
};

const failingJobs = {
  jobs: [
    {
      id: 555,
      name: "test (ubuntu)",
      conclusion: "failure",
      steps: [
        { name: "checkout", conclusion: "success" },
        { name: "pytest", conclusion: "failure" },
      ],
    },
  ],
};

const longLog = Array.from({ length: 60 }, (_, index) => "line " + String(index)).concat([
  "AssertionError: boom",
]).join("\n");

test("ciFailures fetches the failing job log tail when includeLogs is on", async () => {
  const archive = makeZip([{ name: "1_checkout.txt", content: "checkout ok" }, { name: "2_pytest.txt", content: longLog }]);
  const calls = stubFetch([
    { match: /\/commits\/main\/check-runs/, body: failingCheckRuns },
    { match: /\/actions\/runs\/99\/jobs/, body: failingJobs },
    {
      match: /\/actions\/jobs\/555\/logs$/,
      status: 302,
      headers: { location: "https://blob.example/logs/555" },
    },
    { match: /blob\.example\/logs\/555/, binary: archive },
  ]);

  const report = await ciFailures("o/r", "main", "ghp_test", { includeLogs: true, logLines: 20 });

  const tail = report.failures[0]?.logTail ?? "";
  assert.match(tail, /AssertionError: boom/);
  assert.match(tail, /earlier lines omitted/);
  assert.equal(report.failures[0]?.logNote, "");
  assert.equal(calls[2]?.headers["Authorization"], "Bearer ghp_test");
  assert.equal(calls[3]?.headers["Authorization"], undefined);
});

test("ciFailures decodes the plain-text log GitHub serves behind the redirect", async () => {
  const plain = Buffer.from(
    "\uFEFF2026-11-11T10:54:42.1832612Z Current runner version: '2.338.2'\r\n" +
      "2026-11-11T10:54:43.0000000Z ##[group]Run npm test\r\n" +
      "2026-11-11T10:55:10.6377345Z AssertionError: boom\r\n",
    "utf8",
  );
  stubFetch([
    { match: /\/commits\/main\/check-runs/, body: failingCheckRuns },
    { match: /\/actions\/runs\/99\/jobs/, body: failingJobs },
    { match: /\/actions\/jobs\/555\/logs$/, status: 302, headers: { location: "https://blob.example/logs/555" } },
    { match: /blob\.example\/logs\/555/, binary: plain },
  ]);

  const report = await ciFailures("o/r", "main", "ghp_test", { includeLogs: true });
  const tail = report.failures[0]?.logTail ?? "";
  assert.match(tail, /^Current runner version: '2\.338\.2'$/m);
  assert.match(tail, /^AssertionError: boom$/m);
  assert.equal(tail.includes("\uFEFF"), false);
  assert.equal(/^\d{4}-\d{2}-\d{2}T/m.test(tail), false);
});

test("ciFailures leaves the log alone unless asked", async () => {
  const calls = stubFetch([
    { match: /\/commits\/main\/check-runs/, body: failingCheckRuns },
    { match: /\/actions\/runs\/99\/jobs/, body: failingJobs },
  ]);

  const report = await ciFailures("o/r", "main", null);
  assert.equal(report.failures[0]?.logTail, "");
  assert.equal(report.failures[0]?.logNote, "");
  assert.equal(
    calls.filter((call) => call.url.includes("/logs")).length,
    0,
  );
});

test("ciFailures explains why a log tail is missing", async () => {
  stubFetch([
    { match: /\/commits\/main\/check-runs/, body: failingCheckRuns },
    { match: /\/actions\/runs\/99\/jobs/, body: failingJobs },
    { match: /\/actions\/jobs\/555\/logs$/, status: 404, body: { message: "Not Found" } },
  ]);

  const report = await ciFailures("o/r", "main", "ghp_test", { includeLogs: true });
  assert.match(report.failures[0]?.logNote ?? "", /404/);
});

test("createPullRequest posts the expected payload", async () => {
  const calls = stubFetch([
    {
      match: /\/repos\/o\/r\/pulls$/,
      body: { number: 42, html_url: "https://github.com/o/r/pull/42", title: "feat: x", draft: true },
    },
  ]);

  const pr = await createPullRequest(
    { repo: "o/r", title: "feat: x", head: "feat/x", base: "main", body: "body text", draft: true },
    "ghp_test",
  );

  assert.deepEqual(pr, { number: 42, url: "https://github.com/o/r/pull/42", title: "feat: x", draft: true });
  assert.equal(calls[0]?.method, "POST");
  assert.equal(calls[0]?.headers["Authorization"], "Bearer ghp_test");
  const payload = JSON.parse(calls[0]?.body ?? "{}") as Record<string, unknown>;
  assert.equal(payload["head"], "feat/x");
  assert.equal(payload["base"], "main");
  assert.equal(payload["draft"], true);
});

test("write calls refuse to run without a token", async () => {
  await assert.rejects(
    () => createPullRequest({ repo: "o/r", title: "x", head: "a", base: "b" }, null),
    /needs GITHUB_TOKEN/,
  );
  await assert.rejects(() => createIssue({ repo: "o/r", title: "x" }, null), /needs GITHUB_TOKEN/);
  await assert.rejects(() => commentOnThread({ repo: "o/r", number: 1, body: "x" }, null), /needs GITHUB_TOKEN/);
});

test("createIssue only sends labels that were provided", async () => {
  const withLabels = stubFetch([
    { match: /\/repos\/o\/r\/issues$/, body: { number: 3, html_url: "u", title: "t" } },
  ]);
  await createIssue({ repo: "o/r", title: "t", labels: ["bug", " "] }, "ghp_test");
  const first = JSON.parse(withLabels[0]?.body ?? "{}") as Record<string, unknown>;
  assert.deepEqual(first["labels"], ["bug"]);

  const withoutLabels = stubFetch([
    { match: /\/repos\/o\/r\/issues$/, body: { number: 3, html_url: "u", title: "t" } },
  ]);
  await createIssue({ repo: "o/r", title: "t" }, "ghp_test");
  const second = JSON.parse(withoutLabels[0]?.body ?? "{}") as Record<string, unknown>;
  assert.equal("labels" in second, false);
});

test("commentOnThread posts to the issue comments endpoint", async () => {
  const calls = stubFetch([
    { match: /\/repos\/o\/r\/issues\/7\/comments$/, body: { id: 9, html_url: "https://github.com/o/r/issues/7#c9" } },
  ]);
  const comment = await commentOnThread({ repo: "o/r", number: 7, body: "thanks" }, "ghp_test");
  assert.equal(comment.id, 9);
  assert.equal(calls[0]?.method, "POST");
});

test("a rejected write surfaces GitHub's reason", async () => {
  stubFetch([
    {
      match: /\/repos\/o\/r\/pulls$/,
      status: 422,
      body: { message: "Validation Failed", errors: [{ message: "No commits between main and feat/x" }] },
    },
  ]);
  await assert.rejects(
    () => createPullRequest({ repo: "o/r", title: "x", head: "feat/x", base: "main" }, "ghp_test"),
    /422.*No commits between/,
  );
});
