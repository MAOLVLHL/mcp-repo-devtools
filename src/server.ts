/**
 * Tool registration. Every tool is read-only and returns text shaped for a
 * model: a short header, then at most 200 lines / 64 KB.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { assertAllowedRepo, parseAllowedRoots } from "./config.js";
import { gitDiff, gitLog, gitStatus } from "./git.js";
import { ciFailures, prContext, resolveToken, searchIssues } from "./github.js";
import { clip, redact } from "./text.js";

export const VERSION = "0.1.0";
export const SERVER_NAME = "mcp-repo-devtools";

export interface ServerOptions {
  allowedRoots?: string[];
  token?: string | null;
}

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

async function guarded(work: () => Promise<string>): Promise<CallToolResult> {
  try {
    return ok(clip(redact(await work())));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text", text: "Error: " + message }], isError: true };
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

  const server = new McpServer({ name: SERVER_NAME, version: VERSION });

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
    },
    async ({ repo }) =>
      guarded(async () => formatStatus(await gitStatus(resolveRepo(repo)))),
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
    },
    async ({ repo, path, limit }) =>
      guarded(async () => {
        const root = resolveRepo(repo);
        return formatLog(await gitLog(root, { path, limit }), path);
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
    },
    async ({ repo, base, path, mode, context_lines }) =>
      guarded(async () => {
        const root = resolveRepo(repo);
        const body = await gitDiff(root, { base, path, mode, contextLines: context_lines });
        return "diff (" + mode + ") against " + (base ?? "HEAD") + (path ? " for " + path : "") + "\n\n" + body;
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
    },
    async ({ repo, query, state, limit }) =>
      guarded(async () =>
        formatIssues(await searchIssues({ repo, query, state, limit }, token), "issues in " + repo + " matching " + JSON.stringify(query) + " (" + state + ")"),
      ),
  );

  server.registerTool(
    "gh_ci_failures",
    {
      title: "GitHub CI failures",
      description:
        "List failing check runs for a commit or branch/PR head, with the failed step names when GitHub exposes them. " +
        "Read-only. Use this instead of reading a whole CI log: it returns only the failures.",
      inputSchema: {
        repo: z.string().describe("Repository as owner/name"),
        ref: z.string().describe("Commit sha, branch name, tag or PR head ref"),
      },
    },
    async ({ repo, ref }) =>
      guarded(async () => formatCi(await ciFailures(repo, ref, token), repo)),
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
    },
    async ({ repo, number }) =>
      guarded(async () => formatPr(await prContext(repo, number, token), repo)),
  );

  return server;
}
