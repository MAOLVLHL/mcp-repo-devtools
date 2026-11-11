/**
 * Machine-readable tool metadata: what a tool does to the world, and the shape
 * of what it returns. Registration reads these, and tests and docs import the
 * same definitions, so the contract cannot drift away from the code.
 */

import { z } from "zod";

/**
 * Annotations are hints: a host may show them, and no host should make a
 * security decision with them. `openWorldHint` marks a tool whose answers
 * depend on state outside this machine.
 */
export const LOCAL_READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export const REMOTE_READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export const REMOTE_WRITE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

/** Sent once at initialize, before the model sees a single tool. */
export const SERVER_INSTRUCTIONS = [
  "This server reads git history and GitHub state; a result is text, plus the same data as structured content when the tool declares an output schema.",
  "Start with git_status to see what changed, then git_log or git_diff scoped with path=.",
  "Results are capped at 64 KB and 200 lines, and the last line says which argument narrows them.",
  "GitHub tools need GITHUB_TOKEN for anything beyond 60 requests per hour.",
  "Write tools appear only when MCP_ENABLE_WRITE=1, and are annotated destructive: they open a pull request, file an issue or post a comment.",
].join(" ");

/** `git_status`: the working tree as fields, not only as printed lines. */
export const gitStatusOutput = {
  branch: z.string().describe("Current branch name"),
  upstream: z.string().nullable().describe("Upstream ref, null when the branch has none"),
  ahead: z.number().int().describe("Commits ahead of upstream"),
  behind: z.number().int().describe("Commits behind upstream"),
  changes: z.array(
    z.object({
      status: z.string().describe("git's two-letter status, e.g. M, A, ??, R"),
      path: z.string(),
    }),
  ),
  truncated: z.boolean().describe("True when the tree has more changed paths than the 200 kept"),
};

/** `git_log`: commits already parsed into fields. */
export const gitLogOutput = {
  path: z.string().nullable().describe("Path the history was scoped to, null for the whole tree"),
  commits: z.array(
    z.object({
      hash: z.string().describe("Abbreviated commit hash"),
      date: z.string().describe("Author date, YYYY-MM-DD"),
      author: z.string(),
      subject: z.string(),
    }),
  ),
};

/** `git_diff`: the rendered diff plus what it was diffed against. */
export const gitDiffOutput = {
  base: z.string().describe("Revision the working tree was diffed against"),
  path: z.string().nullable().describe("Path the diff was scoped to, null for the whole tree"),
  mode: z.enum(["stat", "patch"]),
  diff: z
    .string()
    .describe("Rendered diff, capped like the text; truncated=true when it was cut"),
  truncated: z.boolean().describe("True when the diff was cut to fit the output budget"),
};

/** `gh_issue_search`: issues only, pull requests filtered out. */
export const issueSearchOutput = {
  repo: z.string().describe("Repository as owner/name"),
  query: z.string().describe("Search terms as sent, after defaulting"),
  state: z.enum(["open", "closed", "all"]),
  totalCount: z.number().int().describe("Matches GitHub reported, which can exceed the returned issues"),
  issues: z.array(
    z.object({
      number: z.number().int(),
      title: z.string(),
      state: z.string(),
      labels: z.array(z.string()),
      updatedAt: z.string().describe("ISO timestamp of the last activity"),
      url: z.string(),
      bodyExcerpt: z.string().describe("First 240 characters of the body, flattened"),
    }),
  ),
};

/** `gh_ci_failures`: only failing checks, with the log tail when asked. */
export const ciFailuresOutput = {
  repo: z.string().describe("Repository as owner/name"),
  ref: z.string().describe("The ref that was resolved, e.g. a full sha"),
  sha: z.string().nullable().describe("Resolved commit sha, null when the ref did not resolve to a commit"),
  checkedRuns: z.number().int().describe("Check runs GitHub reported for the ref"),
  failures: z.array(
    z.object({
      name: z.string(),
      conclusion: z.string(),
      title: z.string(),
      summary: z.string(),
      detailsUrl: z.string(),
      failedSteps: z.array(z.string()),
      logTail: z.string().describe("Tail of the job log, empty unless include_logs was set"),
      logNote: z.string().describe("Why a requested log is missing, e.g. the archive expired"),
    }),
  ),
};

/** `gh_pr_context`: what a reviewer needs, in one call. */
export const prContextOutput = {
  repo: z.string().describe("Repository as owner/name"),
  number: z.number().int(),
  title: z.string(),
  state: z.string(),
  draft: z.boolean(),
  author: z.string(),
  base: z.string(),
  head: z.string(),
  additions: z.number().int(),
  deletions: z.number().int(),
  changedFiles: z.number().int().describe("Files changed in total, which can exceed the files array"),
  bodyExcerpt: z.string(),
  files: z.array(
    z.object({
      filename: z.string(),
      status: z.string(),
      additions: z.number().int(),
      deletions: z.number().int(),
    }),
  ),
  filesTruncated: z.boolean().describe("True when the PR changes more files than the 100 kept"),
  reviews: z.array(
    z.object({
      author: z.string(),
      state: z.string(),
      bodyExcerpt: z.string(),
    }),
  ),
  comments: z.array(
    z.object({
      path: z.string(),
      line: z.number().int().nullable().describe("Line the comment is anchored to, null for a file-level comment"),
      author: z.string(),
      bodyExcerpt: z.string(),
    }),
  ),
};
