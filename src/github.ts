/**
 * GitHub REST access for issues, CI results and pull request context.
 * Every string returned here is redacted before it reaches a model.
 */

import { assertSafeRef } from "./git.js";
import { redact } from "./text.js";

const API_BASE = "https://api.github.com";
const TIMEOUT_MS = 15_000;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export class GitHubError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
  }
}

/** Token is optional: unauthenticated reads work, at 60 requests per hour. */
export function resolveToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env["GITHUB_TOKEN"] ?? env["GH_TOKEN"];
  const token = raw?.trim();
  return token && token.length > 0 ? token : null;
}

export function assertRepoName(repo: string): string {
  const value = repo.trim();
  if (!REPO_PATTERN.test(value)) {
    throw new Error("repo must look like owner/name, got: " + JSON.stringify(repo));
  }
  return value;
}

async function ghFetch<T>(pathname: string, token: string | null): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "mcp-repo-devtools/0.1.0",
  };
  if (token) {
    headers["Authorization"] = "Bearer " + token;
  }

  let response: Response;
  try {
    response = await fetch(API_BASE + pathname, {
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new GitHubError("could not reach api.github.com: " + message, null);
  }

  if (!response.ok) {
    const body = redact((await response.text()).slice(0, 400));
    const remaining = response.headers.get("x-ratelimit-remaining");
    const reset = response.headers.get("x-ratelimit-reset");
    if (response.status === 401) {
      throw new GitHubError("GitHub rejected the token (401). Check GITHUB_TOKEN.", 401);
    }
    if (response.status === 403 && remaining === "0") {
      const when = reset ? new Date(Number(reset) * 1000).toISOString() : "unknown";
      throw new GitHubError(
        "GitHub rate limit exhausted; resets at " + when + ". Set GITHUB_TOKEN to get 5000 requests/hour.",
        403,
      );
    }
    if (response.status === 404) {
      throw new GitHubError(
        "GitHub returned 404 for " + pathname + ". Check the repository name and token scopes.",
        404,
      );
    }
    throw new GitHubError(
      "GitHub returned " + response.status + " for " + pathname + ": " + body,
      response.status,
    );
  }

  return (await response.json()) as T;
}

function excerpt(value: string | null | undefined, limit: number): string {
  if (!value) {
    return "";
  }
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : flat.slice(0, limit) + "…";
}

export interface IssueSearchOptions {
  repo: string;
  query: string;
  state: "open" | "closed" | "all";
  limit: number;
}

export interface IssueSummary {
  number: number;
  title: string;
  state: string;
  labels: string[];
  updatedAt: string;
  url: string;
  bodyExcerpt: string;
}

interface RawIssue {
  number: number;
  title: string;
  state: string;
  html_url: string;
  updated_at: string;
  body: string | null;
  labels: Array<string | { name?: string }>;
  pull_request?: unknown;
}

interface IssueSearchResponse {
  total_count: number;
  items: RawIssue[];
}

/** Search issues (never pull requests) with GitHub's search API. */
export async function searchIssues(
  options: IssueSearchOptions,
  token: string | null,
): Promise<{ totalCount: number; items: IssueSummary[] }> {
  const repo = assertRepoName(options.repo);
  const parts = ["repo:" + repo, "is:issue"];
  if (options.state !== "all") {
    parts.push("state:" + options.state);
  }
  const query = options.query.trim();
  if (query.length > 0) {
    parts.push(query);
  }

  const pathname =
    "/search/issues?q=" +
    encodeURIComponent(parts.join(" ")) +
    "&sort=updated&order=desc&per_page=" +
    String(options.limit);

  const data = await ghFetch<IssueSearchResponse>(pathname, token);
  const items = data.items
    .filter((issue) => issue.pull_request === undefined)
    .slice(0, options.limit)
    .map((issue) => ({
      number: issue.number,
      title: issue.title,
      state: issue.state,
      labels: issue.labels.map((label) => (typeof label === "string" ? label : (label.name ?? ""))).filter(Boolean),
      updatedAt: issue.updated_at,
      url: issue.html_url,
      bodyExcerpt: excerpt(issue.body, 240),
    }));

  return { totalCount: data.total_count, items };
}

export interface CiFailure {
  name: string;
  conclusion: string;
  title: string;
  summary: string;
  detailsUrl: string;
  failedSteps: string[];
}

export interface CiFailureReport {
  ref: string;
  sha: string | null;
  checkedRuns: number;
  failures: CiFailure[];
}

interface RawCheckRuns {
  total_count: number;
  check_runs: Array<{
    name: string;
    status: string;
    conclusion: string | null;
    details_url: string | null;
    head_sha: string;
    output?: { title?: string | null; summary?: string | null };
  }>;
}

interface RawJobs {
  jobs: Array<{ name: string; conclusion: string | null; steps?: Array<{ name: string; conclusion: string | null }> }>;
}

const FAILING_CONCLUSIONS: ReadonlySet<string> = new Set([
  "failure",
  "timed_out",
  "cancelled",
  "action_required",
]);

const MAX_FAILING_RUNS = 10;
const MAX_JOB_LOOKUPS = 5;

/** List failing checks for a ref, with the failed step names when available. */
export async function ciFailures(
  repoInput: string,
  refInput: string,
  token: string | null,
): Promise<CiFailureReport> {
  const repo = assertRepoName(repoInput);
  const ref = assertSafeRef(refInput, "ref");
  const data = await ghFetch<RawCheckRuns>(
    "/repos/" + repo + "/commits/" + encodeURIComponent(ref) + "/check-runs?per_page=100&filter=latest",
    token,
  );

  const failing = data.check_runs.filter(
    (run) => run.conclusion !== null && FAILING_CONCLUSIONS.has(run.conclusion),
  );
  const sha = data.check_runs[0]?.head_sha ?? null;
  const failures: CiFailure[] = [];
  let lookups = 0;

  for (const run of failing.slice(0, MAX_FAILING_RUNS)) {
    const failedSteps: string[] = [];
    const detailsUrl = run.details_url ?? "";
    const runMatch = /\/actions\/runs\/(\d+)/.exec(detailsUrl);
    if (runMatch && lookups < MAX_JOB_LOOKUPS) {
      lookups += 1;
      try {
        const jobs = await ghFetch<RawJobs>(
          "/repos/" + repo + "/actions/runs/" + String(runMatch[1]) + "/jobs?per_page=100&filter=latest",
          token,
        );
        for (const job of jobs.jobs) {
          for (const step of job.steps ?? []) {
            if (step.conclusion === "failure" || step.conclusion === "timed_out") {
              failedSteps.push(job.name + " / " + step.name);
            }
          }
        }
      } catch {
        // Job details are best-effort; the check run itself is the contract.
      }
    }
    failures.push({
      name: run.name,
      conclusion: run.conclusion ?? "unknown",
      title: run.output?.title ?? "",
      summary: excerpt(run.output?.summary, 400),
      detailsUrl,
      failedSteps: failedSteps.slice(0, 10),
    });
  }

  return { ref, sha, checkedRuns: data.total_count, failures };
}

export interface PrFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
}

export interface PrContext {
  number: number;
  title: string;
  state: string;
  draft: boolean;
  author: string;
  base: string;
  head: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  bodyExcerpt: string;
  files: PrFile[];
  reviews: Array<{ author: string; state: string; bodyExcerpt: string }>;
  comments: Array<{ path: string; line: number | null; author: string; bodyExcerpt: string }>;
}

interface RawPull {
  number: number;
  title: string;
  state: string;
  draft: boolean;
  user: { login: string };
  base: { ref: string };
  head: { ref: string };
  additions: number;
  deletions: number;
  changed_files: number;
  body: string | null;
}

interface RawFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
}

interface RawReview {
  user: { login: string };
  state: string;
  body: string | null;
}

interface RawReviewComment {
  path: string;
  line: number | null;
  user: { login: string };
  body: string;
}

/** Everything a reviewer usually needs before touching a PR, in one call. */
export async function prContext(
  repoInput: string,
  pullNumber: number,
  token: string | null,
): Promise<PrContext> {
  const repo = assertRepoName(repoInput);
  if (!Number.isInteger(pullNumber) || pullNumber <= 0) {
    throw new Error("number must be a positive integer");
  }
  const base = "/repos/" + repo + "/pulls/" + String(pullNumber);

  const [pull, files, reviews, comments] = await Promise.all([
    ghFetch<RawPull>(base, token),
    ghFetch<RawFile[]>(base + "/files?per_page=100", token),
    ghFetch<RawReview[]>(base + "/reviews?per_page=50", token),
    ghFetch<RawReviewComment[]>(base + "/comments?per_page=50", token),
  ]);

  return {
    number: pull.number,
    title: pull.title,
    state: pull.state,
    draft: pull.draft,
    author: pull.user.login,
    base: pull.base.ref,
    head: pull.head.ref,
    additions: pull.additions,
    deletions: pull.deletions,
    changedFiles: pull.changed_files,
    bodyExcerpt: excerpt(pull.body, 500),
    files: files.map((file) => ({
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
    })),
    reviews: reviews.map((review) => ({
      author: review.user.login,
      state: review.state,
      bodyExcerpt: excerpt(review.body, 200),
    })),
    comments: comments.map((comment) => ({
      path: comment.path,
      line: comment.line,
      author: comment.user.login,
      bodyExcerpt: excerpt(comment.body, 300),
    })),
  };
}
