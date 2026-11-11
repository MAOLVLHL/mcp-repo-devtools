/**
 * Tool registration. Read-only tools are always on; write tools appear only
 * when MCP_ENABLE_WRITE=1, so the default surface cannot mutate a repository.
 * Every result is text shaped for a model: a short header, then at most
 * 200 lines / 64 KB.
 */

import { readFileSync } from "node:fs";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { assertAllowedRepo, parseAllowedRoots } from "./config.js";
import { gitDiff, gitLog, gitStatus } from "./git.js";
import {
  ciFailures,
  commentOnThread,
  createIssue,
  createPullRequest,
  prContext,
  resolveToken,
  searchIssues,
} from "./github.js";
import { clip, redact, redactDeep } from "./text.js";
import {
  LOCAL_READ,
  REMOTE_READ,
  REMOTE_WRITE,
  SERVER_INSTRUCTIONS,
  ciFailuresOutput,
  gitDiffOutput,
  gitLogOutput,
  gitStatusOutput,
  issueSearchOutput,
  prContextOutput,
} from "./tool-metadata.js";

/**
 * Read from package.json rather than a literal: a second copy of the version
 * drifts the first time someone forgets to bump both.
 */
const PACKAGE = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

export const VERSION: string = PACKAGE.version;
export const SERVER_NAME = "mcp-repo-devtools";

export interface ServerOptions {
  allowedRoots?: string[];
  token?: string | null;
  /** Register the write tools. Defaults to MCP_ENABLE_WRITE=1 in the environment. */
  enableWrite?: boolean;
}

const TRUTHY: ReadonlySet<string> = new Set(["1", "true", "yes", "on"]);

/** Write mode is opt-in: anything other than a truthy value keeps the server read-only. */
export function parseEnableWrite(value: string | undefined): boolean {
  return TRUTHY.has((value ?? "").trim().toLowerCase());
}

function auditWrite(tool: string, target: string): void {
  process.stderr.write("[mcp-repo-devtools] write " + tool + " " + target + "\n");
}

/** A tool result before it is rendered: text for the model, data for a host. */
export interface ToolResult {
  text: string;
  structured: Record<string, unknown>;
}

/** Files echoed in structured pull-request output before it stops being useful. */
const MAX_STRUCTURED_FILES = 100;

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function failure(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: "Error: " + message }], isError: true };
}

/**
 * Drop undefined fields recursively: structuredContent is serialised as JSON,
 * which has no undefined, and a dropped required field fails schema validation.
 */
function dropUndefined(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item: unknown) => dropUndefined(item));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item !== undefined) {
        out[key] = dropUndefined(item);
      }
    }
    return out;
  }
  return value;
}

/**
 * Text is always the answer; structured content is the same data for a host
 * that would rather parse fields than lines. Both pass the redactor, because a
 * secret in a commit subject is as exposed as one in a diff.
 */
function render(result: ToolResult): CallToolResult {
  const body = ok(clip(redact(result.text)));
  return {
    ...body,
    structuredContent: dropUndefined(redactDeep(result.structured)) as Record<string, unknown>,
  };
}

async function guarded(work: () => Promise<string>): Promise<CallToolResult> {
  try {
    return ok(clip(redact(await work())));
  } catch (error) {
    return failure(error);
  }
}

async function guardedStructured(work: () => Promise<ToolResult>): Promise<CallToolResult> {
  try {
    return render(await work());
  } catch (error) {
    return failure(error);
  }
}

function formatStatus(status: Awaited<ReturnType<typeof gitStatus>>): string {
  const lines: string[] = [];
  const upstream = status.upstream ? " (upstream " + status.upstream + ")" : "";
  lines.push(
    "branch " + status.branch + upstream + "  +" + status.ahead + " -" + status.behind,
  );
  lines.push(status.changes.length + " changed path(s)");
  for (const change of status.changes) {
    lines.push(change.status.padEnd(10) + change.path);
  }
  if (status.truncated) {
    lines.push("…truncated (more than " + status.changes.length + " entries; use git_diff with path= to narrow)");
  }
  return lines.join("\n");
}

function formatLog(entries: Awaited<ReturnType<typeof gitLog>>, pathHint: string | undefined): string {
  const scope = pathHint ? " (path " + pathHint + ")" : "";
  const lines = [entries.length + " commit(s)" + scope];
  for (const entry of entries) {
    lines.push([entry.hash, entry.date, entry.author, entry.subject].join("  "));
  }
  return lines.join("\n");
}

function formatIssues(result: Awaited<ReturnType<typeof searchIssues>>, header: string): string {
  const lines = [header, "total matches: " + result.totalCount, ""];
  for (const issue of result.items) {
    const shown = issue.labels.slice(0, 6);
    const extra = issue.labels.length - shown.length;
    const labels =
      shown.length > 0 ? "  [" + shown.join(", ") + (extra > 0 ? ", +" + extra + " more" : "") + "]" : "";
    lines.push("#" + issue.number + " " + issue.state + " " + issue.title + labels);
    lines.push("   " + issue.url + "  updated " + issue.updatedAt.slice(0, 10));
    if (issue.bodyExcerpt) {
      lines.push("   " + issue.bodyExcerpt);
    }
    lines.push("");
  }
  if (result.items.length === 0) {
    lines.push("(no matching issues)");
  }
  return lines.join("\n");
}

function formatCi(report: Awaited<ReturnType<typeof ciFailures>>, repo: string): string {
  const lines = [
    "repo " + repo + "  ref " + report.ref + (report.sha ? "  (" + report.sha.slice(0, 12) + ")" : ""),
    report.checkedRuns + " check run(s), " + report.failures.length + " failing",
  ];
  for (const failure of report.failures) {
    lines.push("");
    lines.push("x " + failure.name + " (" + failure.conclusion + ")  " + failure.detailsUrl);
    if (failure.title) {
      lines.push("  title: " + failure.title);
    }
    if (failure.summary) {
      lines.push("  " + failure.summary);
    }
    for (const step of failure.failedSteps) {
      lines.push("  failed step: " + step);
    }
    if (failure.logNote) {
      lines.push("  log unavailable: " + failure.logNote);
    }
    if (failure.logTail) {
      lines.push("  log tail:");
      for (const line of failure.logTail.split("\n")) {
        lines.push("    " + line);
      }
    }
  }
  if (report.failures.length === 0) {
    lines.push("no failing checks on this ref");
  }
  return lines.join("\n");
}

function formatPr(context: Awaited<ReturnType<typeof prContext>>, repo: string): string {
  const lines = [
    "repo " + repo + "  PR #" + context.number + "  " + context.state + (context.draft ? " (draft)" : ""),
    context.title,
    "by @" + context.author + "  " + context.base + " <- " + context.head,
    context.changedFiles + " file(s), +" + context.additions + " -" + context.deletions,
  ];
  if (context.bodyExcerpt) {
    lines.push("", "body: " + context.bodyExcerpt);
  }
  lines.push("", "files:");
  for (const file of context.files.slice(0, 30)) {
    lines.push("  " + file.status + "  +" + file.additions + " -" + file.deletions + "  " + file.filename);
  }
  if (context.files.length > 30) {
    lines.push("  …" + (context.files.length - 30) + " more files");
  }
  if (context.reviews.length > 0) {
    lines.push("", "reviews:");
    for (const review of context.reviews) {
      lines.push("  @" + review.author + " " + review.state + (review.bodyExcerpt ? ": " + review.bodyExcerpt : ""));
    }
  }
  if (context.comments.length > 0) {
    lines.push("", "review comments:");
    for (const comment of context.comments) {
      lines.push("  " + comment.path + (comment.line === null ? "" : ":" + comment.line) + " @" + comment.author + " — " + comment.bodyExcerpt);
    }
  }
  return lines.join("\n");
}

/** Build the MCP server with all tools registered. */
export function createServer(options: ServerOptions = {}): McpServer {
  const roots = options.allowedRoots ?? parseAllowedRoots(process.env["MCP_ALLOWED_ROOTS"]);
  const token = options.token === undefined ? resolveToken() : options.token;
  const writeEnabled = options.enableWrite ?? parseEnableWrite(process.env["MCP_ENABLE_WRITE"]);

  const server = new McpServer(
    { name: SERVER_NAME, version: VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );

  const resolveRepo = (repo: string): string => assertAllowedRepo(repo, roots);

  server.registerTool(
    "git_status",
    {
      title: "git status",
      description:
        "Summarise a repository's working tree: current branch, upstream, ahead/behind counts and changed paths. " +
        "Read-only. Use this before deciding what to look at with git_diff.",
      inputSchema: {
        repo: z.string().describe("Absolute path to a git working tree, inside MCP_ALLOWED_ROOTS"),
      },
      outputSchema: gitStatusOutput,
      annotations: LOCAL_READ,
    },
    async ({ repo }) =>
      guardedStructured(async () => {
        const status = await gitStatus(resolveRepo(repo));
        return {
          text: formatStatus(status),
          structured: {
            branch: status.branch,
            upstream: status.upstream,
            ahead: status.ahead,
            behind: status.behind,
            changes: status.changes,
            truncated: status.truncated,
          },
        };
      }),
  );

  server.registerTool(
    "git_log",
    {
      title: "git log",
      description:
        "List the newest commits (hash, date, author, subject), newest first. Read-only. " +
        "Use path= to scope to a file or directory, limit= to cap the number of commits (max 100).",
      inputSchema: {
        repo: z.string().describe("Absolute path to a git working tree, inside MCP_ALLOWED_ROOTS"),
        path: z.string().optional().describe("File or directory to scope the history to"),
        limit: z.number().int().min(1).max(100).default(20).describe("Number of commits to return"),
      },
      outputSchema: gitLogOutput,
      annotations: LOCAL_READ,
    },
    async ({ repo, path, limit }) =>
      guardedStructured(async () => {
        const commits = await gitLog(resolveRepo(repo), { path, limit });
        return {
          text: formatLog(commits, path),
          structured: { path: path ?? null, commits },
        };
      }),
  );

  server.registerTool(
    "git_diff",
    {
      title: "git diff",
      description:
        "Diff the working tree against a base revision (default HEAD). Read-only. " +
        "mode='stat' (default) returns file names with line counts; mode='patch' returns the unified diff. " +
        "If the output ends with a truncation note, narrow with path= or reduce context_lines=.",
      inputSchema: {
        repo: z.string().describe("Absolute path to a git working tree, inside MCP_ALLOWED_ROOTS"),
        base: z.string().optional().describe("Base revision, e.g. HEAD, main, a tag or a sha (default HEAD)"),
        path: z.string().optional().describe("File or directory to diff"),
        mode: z.enum(["stat", "patch"]).default("stat").describe("stat = summary, patch = full unified diff"),
        context_lines: z.number().int().min(0).max(50).default(3).describe("Context lines per hunk in patch mode"),
      },
      outputSchema: gitDiffOutput,
      annotations: LOCAL_READ,
    },
    async ({ repo, base, path, mode, context_lines }) =>
      guardedStructured(async () => {
        const body = await gitDiff(resolveRepo(repo), { base, path, mode, contextLines: context_lines });
        const shown = clip(body, { hint: "narrow with path= or lower context_lines=" });
        return {
          text: "diff (" + mode + ") against " + (base ?? "HEAD") + (path ? " for " + path : "") + "\n\n" + body,
          structured: {
            base: base ?? "HEAD",
            path: path ?? null,
            mode,
            diff: shown,
            truncated: shown !== body,
          },
        };
      }),
  );

  server.registerTool(
    "gh_issue_search",
    {
      title: "search GitHub issues",
      description:
        "Search issues in one repository with GitHub's search API, newest activity first. " +
        "Read-only. Returns issue number, title, labels, updated date, url and a body excerpt. " +
        "Requires GITHUB_TOKEN for anything beyond 60 requests/hour.",
      inputSchema: {
        repo: z.string().describe("Repository as owner/name, e.g. emcie-co/parlant"),
        query: z.string().default("").describe("Search terms, e.g. 'timeout' or 'label:bug sse'"),
        state: z.enum(["open", "closed", "all"]).default("open").describe("Issue state filter"),
        limit: z.number().int().min(1).max(30).default(10).describe("Maximum issues to return"),
      },
      outputSchema: issueSearchOutput,
      annotations: REMOTE_READ,
    },
    async ({ repo, query, state, limit }) =>
      guardedStructured(async () => {
        const result = await searchIssues({ repo, query, state, limit }, token);
        return {
          text: formatIssues(
            result,
            "issues in " + repo + " matching " + JSON.stringify(query) + " (" + state + ")",
          ),
          structured: { repo, query, state, totalCount: result.totalCount, issues: result.items },
        };
      }),
  );

  server.registerTool(
    "gh_ci_failures",
    {
      title: "GitHub CI failures",
      description:
        "List failing check runs for a commit or branch/PR head, with the failed step names when GitHub exposes them. " +
        "Read-only. Set include_logs=true to also get the tail of the failing job's log, which is usually where the " +
        "error is; that costs one extra request per job (up to three jobs).",
      inputSchema: {
        repo: z.string().describe("Repository as owner/name"),
        ref: z.string().describe("Commit sha, branch name, tag or PR head ref"),
        include_logs: z
          .boolean()
          .default(false)
          .describe("Fetch the log tail of up to three failing jobs (needs GITHUB_TOKEN)"),
        log_lines: z
          .number()
          .int()
          .min(10)
          .max(200)
          .default(40)
          .describe("Lines of log tail kept per job"),
      },
      outputSchema: ciFailuresOutput,
      annotations: REMOTE_READ,
    },
    async ({ repo, ref, include_logs, log_lines }) =>
      guardedStructured(async () => {
        const report = await ciFailures(repo, ref, token, {
          includeLogs: include_logs,
          logLines: log_lines,
        });
        return {
          text: formatCi(report, repo),
          structured: {
            repo,
            ref: report.ref,
            sha: report.sha,
            checkedRuns: report.checkedRuns,
            failures: report.failures,
          },
        };
      }),
  );

  server.registerTool(
    "gh_pr_context",
    {
      title: "GitHub pull request context",
      description:
        "Fetch everything needed to review a pull request in one call: title, body excerpt, base/head, size, " +
        "changed files, review states and review comments. Read-only.",
      inputSchema: {
        repo: z.string().describe("Repository as owner/name"),
        number: z.number().int().positive().describe("Pull request number"),
      },
      outputSchema: prContextOutput,
      annotations: REMOTE_READ,
    },
    async ({ repo, number }) =>
      guardedStructured(async () => {
        const context = await prContext(repo, number, token);
        return {
          text: formatPr(context, repo),
          structured: {
            repo,
            number: context.number,
            title: context.title,
            state: context.state,
            draft: context.draft,
            author: context.author,
            base: context.base,
            head: context.head,
            additions: context.additions,
            deletions: context.deletions,
            changedFiles: context.changedFiles,
            bodyExcerpt: context.bodyExcerpt,
            files: context.files.slice(0, MAX_STRUCTURED_FILES),
            filesTruncated: context.files.length > MAX_STRUCTURED_FILES,
            reviews: context.reviews,
            comments: context.comments,
          },
        };
      }),
  );

  if (writeEnabled) {
    server.registerTool(
      "gh_pr_create",
      {
        title: "open a pull request",
        description:
          "Open a pull request from an already-pushed branch. WRITE: mutates GitHub, so it is only registered when " +
          "MCP_ENABLE_WRITE=1. Requires GITHUB_TOKEN with repo scope. Returns the PR number and url.",
        inputSchema: {
          repo: z.string().describe("Repository as owner/name"),
          title: z.string().describe("Pull request title"),
          head: z.string().describe("Source branch, already pushed to the remote"),
          base: z.string().describe("Target branch, e.g. main or develop"),
          body: z.string().default("").describe("Pull request description (markdown)"),
          draft: z.boolean().default(false).describe("Open as a draft"),
        },
        annotations: REMOTE_WRITE,
      },
      async ({ repo, title, head, base, body, draft }) =>
        guarded(async () => {
          auditWrite("gh_pr_create", repo + " " + head + " -> " + base);
          const pr = await createPullRequest({ repo, title, head, base, body, draft }, token);
          return [
            "opened PR #" + pr.number + (pr.draft ? " (draft)" : ""),
            pr.title,
            pr.url,
          ].join("\n");
        }),
    );

    server.registerTool(
      "gh_issue_create",
      {
        title: "file an issue",
        description:
          "File an issue. WRITE: mutates GitHub, so it is only registered when MCP_ENABLE_WRITE=1. " +
          "Requires GITHUB_TOKEN with repo scope. Returns the issue number and url.",
        inputSchema: {
          repo: z.string().describe("Repository as owner/name"),
          title: z.string().describe("Issue title"),
          body: z.string().default("").describe("Issue body (markdown)"),
          labels: z.array(z.string()).default([]).describe("Labels to attach; unknown labels are reported by GitHub"),
        },
        annotations: REMOTE_WRITE,
      },
      async ({ repo, title, body, labels }) =>
        guarded(async () => {
          auditWrite("gh_issue_create", repo);
          const issue = await createIssue({ repo, title, body, labels }, token);
          return ["filed issue #" + issue.number, issue.title, issue.url].join("\n");
        }),
    );

    server.registerTool(
      "gh_pr_comment",
      {
        title: "comment on a pull request or issue",
        description:
          "Post a comment on an issue or pull request. WRITE: mutates GitHub, so it is only registered when " +
          "MCP_ENABLE_WRITE=1. Requires GITHUB_TOKEN with repo scope.",
        inputSchema: {
          repo: z.string().describe("Repository as owner/name"),
          number: z.number().int().positive().describe("Issue or pull request number"),
          body: z.string().describe("Comment body (markdown)"),
        },
        annotations: REMOTE_WRITE,
      },
      async ({ repo, number, body }) =>
        guarded(async () => {
          auditWrite("gh_pr_comment", repo + "#" + String(number));
          const comment = await commentOnThread({ repo, number, body }, token);
          return "commented on " + repo + "#" + String(number) + "\n" + comment.url;
        }),
    );
  }

  return server;
}