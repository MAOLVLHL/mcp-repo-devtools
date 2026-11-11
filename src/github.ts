/**
 * GitHub REST access for issues, CI results and pull request context.
 * Every string returned here is redacted before it reaches a model.
 */

import { assertSafeRef } from "./git.js";
import { redact, tailLines } from "./text.js";
import { decodeLogArchive } from "./zip.js";

const API_BASE = "https://api.github.com";
const TIMEOUT_MS = 15_000;
const LOG_TIMEOUT_MS = 30_000;
const MAX_LOG_BYTES = 16 * 1024 * 1024;
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
  /** Tail of the failing job's log, empty unless includeLogs was requested. */
  logTail: string;
  /** Why a requested log tail is missing, e.g. the archive expired. */
  logNote: string;
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

interface RawJob {
  id: number;
  name: string;
  conclusion: string | null;
  steps?: Array<{ name: string; conclusion: string | null }>;
}

interface RawJobs {
  jobs: RawJob[];
}

const FAILING_CONCLUSIONS: ReadonlySet<string> = new Set([
  "failure",
  "timed_out",
  "cancelled",
  "action_required",
]);

const MAX_FAILING_RUNS = 10;
const MAX_JOB_LOOKUPS = 5;
const MAX_LOG_JOBS = 3;
const DEFAULT_LOG_LINES = 40;

export interface CiFailureOptions {
  /** Fetch the log tail of up to three failing jobs. One extra request per job. */
  includeLogs?: boolean;
  /** Lines of log tail kept per job (10..200). */
  logLines?: number;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * Download a binary GitHub endpoint. The logs API answers with a redirect to a
 * signed blob URL, and that URL must not receive our token — so the redirect is
 * followed by hand rather than by fetch.
 */
async function ghDownload(pathname: string, token: string | null): Promise<Buffer> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "mcp-repo-devtools/0.2.0",
  };
  if (token) {
    headers["Authorization"] = "Bearer " + token;
  }

  let response: Response;
  try {
    response = await fetch(API_BASE + pathname, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw new GitHubError("GitHub redirected " + pathname + " without a location header", null);
      }
      response = await fetch(location, { signal: AbortSignal.timeout(LOG_TIMEOUT_MS) });
    }
  } catch (error) {
    if (error instanceof GitHubError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new GitHubError("could not download " + pathname + ": " + message, null);
  }

  if (!response.ok) {
    throw new GitHubError(
      "GitHub returned " + response.status + " for " + pathname + ". Logs expire after 90 days and need GITHUB_TOKEN.",
      response.status,
    );
  }

  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > MAX_LOG_BYTES) {
    throw new GitHubError("log archive is " + length + " bytes, over the 16 MB limit", null);
  }
  return Buffer.from(await response.arrayBuffer());
}

/** Drop the ISO timestamp GitHub prefixes to every runner line, so the tail reads like output. */
function stripLogPrefixes(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z /, ""))
    .join("\n");
}

async function jobLogTail(
  repo: string,
  jobId: number,
  lines: number,
  token: string | null,
): Promise<string> {
  const archive = await ghDownload("/repos/" + repo + "/actions/jobs/" + String(jobId) + "/logs", token);
  const text = decodeLogArchive(archive);
  if (text.length === 0) {
    return "";
  }
  return tailLines(redact(stripLogPrefixes(text)), lines);
}

/** List failing checks for a ref, with failed step names and optionally a log tail. */
export async function ciFailures(
  repoInput: string,
  refInput: string,
  token: string | null,
  options: CiFailureOptions = {},
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
  const logLines = clampInt(options.logLines, DEFAULT_LOG_LINES, 10, 200);
  let lookups = 0;
  let logBudget = options.includeLogs === true ? MAX_LOG_JOBS : 0;

  for (const run of failing.slice(0, MAX_FAILING_RUNS)) {
    const failedSteps: string[] = [];
    let logTail = "";
    let logNote = "";
    const detailsUrl = run.details_url ?? "";
    const runMatch = /\/actions\/runs\/(\d+)/.exec(detailsUrl);
    if (runMatch && lookups < MAX_JOB_LOOKUPS) {
      lookups += 1;
      try {
        const jobs = await ghFetch<RawJobs>(
          "/repos/" + repo + "/actions/runs/" + String(runMatch[1]) + "/jobs?per_page=100&filter=latest",
          token,
        );
        let failingJobId: number | null = null;
        for (const job of jobs.jobs) {
          for (const step of job.steps ?? []) {
            if (step.conclusion === "failure" || step.conclusion === "timed_out") {
              failedSteps.push(job.name + " / " + step.name);
              failingJobId ??= job.id;
            }
          }
        }
        if (logBudget > 0 && failingJobId !== null) {
          logBudget -= 1;
          try {
            logTail = await jobLogTail(repo, failingJobId, logLines, token);
            if (logTail.length === 0) {
              logNote = "no log archive returned for this job";
            }
          } catch (error) {
            logNote = error instanceof Error ? error.message : String(error);
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
      logTail,
      logNote,
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

/** Write calls are gated by the server, so this is the only place a token is required. */
function requireToken(token: string | null, action: string): string {
  if (!token) {
    throw new GitHubError(action + " needs GITHUB_TOKEN with repo scope; reads work without one, writes do not.", 401);
  }
  return token;
}

function requireText(value: string, field: string, limit: number): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(field + " must not be empty");
  }
  if (trimmed.length > limit) {
    throw new Error(field + " is " + trimmed.length + " characters, over the " + limit + " limit");
  }
  return trimmed;
}

async function ghSend<T>(
  pathname: string,
  token: string | null,
  body: unknown,
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "mcp-repo-devtools/0.2.0",
    "Content-Type": "application/json",
  };
  if (token) {
    headers["Authorization"] = "Bearer " + token;
  }

  let response: Response;
  try {
    response = await fetch(API_BASE + pathname, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new GitHubError("could not reach api.github.com: " + message, null);
  }

  if (!response.ok) {
    const detail = redact((await response.text()).slice(0, 600));
    if (response.status === 401) {
      throw new GitHubError("GitHub rejected the token (401). Check GITHUB_TOKEN.", 401);
    }
    if (response.status === 403) {
      throw new GitHubError(
        "GitHub refused the write (403). The token needs repo scope, and the branch must exist on the remote. " + detail,
        403,
      );
    }
    if (response.status === 422) {
      throw new GitHubError("GitHub rejected the request (422): " + detail, 422);
    }
    throw new GitHubError("GitHub returned " + response.status + " for " + pathname + ": " + detail, response.status);
  }

  return (await response.json()) as T;
}

export interface CreatePullRequestInput {
  repo: string;
  title: string;
  head: string;
  base: string;
  body?: string;
  draft?: boolean;
}

export interface CreatedPullRequest {
  number: number;
  url: string;
  title: string;
  draft: boolean;
}

/** Open a pull request. Requires a token; the head branch must already be pushed. */
export async function createPullRequest(
  input: CreatePullRequestInput,
  token: string | null,
): Promise<CreatedPullRequest> {
  const repo = assertRepoName(input.repo);
  const auth = requireToken(token, "opening a pull request");
  const title = requireText(input.title, "title", 300);
  const head = assertSafeRef(input.head, "head");
  const base = assertSafeRef(input.base, "base");
  const body = input.body ?? "";

  const created = await ghSend<{ number: number; html_url: string; title: string; draft: boolean }>(
    "/repos/" + repo + "/pulls",
    auth,
    { title, head, base, body, draft: input.draft === true },
  );
  return {
    number: created.number,
    url: created.html_url,
    title: created.title,
    draft: created.draft,
  };
}

export interface CreateIssueInput {
  repo: string;
  title: string;
  body?: string;
  labels?: string[];
}

export interface CreatedIssue {
  number: number;
  url: string;
  title: string;
}

/** File an issue. Requires a token with repo scope. */
export async function createIssue(
  input: CreateIssueInput,
  token: string | null,
): Promise<CreatedIssue> {
  const repo = assertRepoName(input.repo);
  const auth = requireToken(token, "filing an issue");
  const title = requireText(input.title, "title", 300);
  const labels = (input.labels ?? []).map((label) => label.trim()).filter((label) => label.length > 0);

  const created = await ghSend<{ number: number; html_url: string; title: string }>(
    "/repos/" + repo + "/issues",
    auth,
    { title, body: input.body ?? "", ...(labels.length > 0 ? { labels } : {}) },
  );
  return { number: created.number, url: created.html_url, title: created.title };
}

export interface CommentInput {
  repo: string;
  number: number;
  body: string;
}

export interface CreatedComment {
  id: number;
  url: string;
}

/** Comment on an issue or pull request. Requires a token with repo scope. */
export async function commentOnThread(
  input: CommentInput,
  token: string | null,
): Promise<CreatedComment> {
  const repo = assertRepoName(input.repo);
  const auth = requireToken(token, "commenting");
  if (!Number.isInteger(input.number) || input.number <= 0) {
    throw new Error("number must be a positive integer");
  }
  const body = requireText(input.body, "body", 60_000);

  const created = await ghSend<{ id: number; html_url: string }>(
    "/repos/" + repo + "/issues/" + String(input.number) + "/comments",
    auth,
    { body },
  );
  return { id: created.id, url: created.html_url };
}
