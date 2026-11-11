/**
 * Prompts are the server half of the loop: a named plan a host can offer as
 * a slash command, so a workflow this server documents does not have to be
 * retyped in every session.
 *
 * A prompt is static text interpolated from its arguments. It calls no tool
 * and no model: the agent still decides what to run, and this server stays a
 * data source with an opinion about the order.
 */

import { z } from "zod";

/** The fields of a GetPromptResult this module builds. */
export interface PromptText {
  /** Widened for registerPrompt, which expects an open record. */
  [key: string]: unknown;
  description: string;
  messages: Array<{ role: "user"; content: { type: "text"; text: string } }>;
}

export const DIAGNOSE_CI = "diagnose-ci";
export const REVIEW_PR = "review-pr";
export const TRIAGE_ISSUES = "triage-issues";

export const diagnoseCiArgs = {
  repo: z.string().describe("Repository as owner/name, e.g. acme/widget"),
  ref: z.string().describe("Commit sha, branch name, tag or pull request head ref"),
  worktree: z
    .string()
    .optional()
    .describe("Absolute path to a local checkout of the same repository, inside MCP_ALLOWED_ROOTS"),
};

export const reviewPrArgs = {
  repo: z.string().describe("Repository as owner/name"),
  number: z
    .string()
    .regex(/^[1-9][0-9]*$/)
    .describe("Pull request number"),
  worktree: z
    .string()
    .optional()
    .describe("Absolute path to a local checkout of the same repository, inside MCP_ALLOWED_ROOTS"),
};

export const triageIssuesArgs = {
  repo: z.string().describe("Repository as owner/name"),
  query: z.string().optional().describe("Search terms, e.g. timeout, or label:bug sse"),
  worktree: z
    .string()
    .optional()
    .describe("Absolute path to a local checkout of the same repository, inside MCP_ALLOWED_ROOTS"),
};

/** A local checkout, or a phrase that keeps the sentence readable when there is none. */
function treeAt(worktree: string | undefined): string {
  return worktree ? JSON.stringify(worktree) : "the repository root";
}

/**
 * The CI plan stops at a diagnosis on purpose: a prompt that also edits turns
 * one reviewable step into an unattended one.
 */
export function diagnoseCiText(input: { repo: string; ref: string; worktree?: string }): string {
  return [
    "Diagnose the failing CI checks for " + input.repo + " at " + input.ref + ", and stop before changing anything.",
    "",
    "1. Call gh_ci_failures with repo=" + JSON.stringify(input.repo) + ", ref=" + JSON.stringify(input.ref) +
      ", include_logs=true. If it reports no failing checks, say so and stop.",
    "2. Read the failed step names and the log tails. Pick the one failure that explains the others: normally the " +
      "first failing job in the run, not the noisiest log.",
    "3. Map the log line to code. Call git_log with repo=" + treeAt(input.worktree) + " and path=<the suspected path>, " +
      "limit=10, then git_diff with mode=\"patch\" and the same path=. If no checkout was given, name the files the " +
      "log points at and stop there.",
    "4. Report, in this order: the failing check, the single error line, the file and line most likely responsible, " +
      "the commit that introduced it when git_log shows one, and the smallest change you would try.",
    "",
    "Do not edit files, do not push, and do not comment on the pull request. The output of this prompt is a " +
      "diagnosis for a human to approve.",
  ].join("\n");
}

/** The review plan reads the change before judging it, and never posts the review. */
export function reviewPrText(input: { repo: string; number: string; worktree?: string }): string {
  return [
    "Review " + input.repo + "#" + input.number + " and report your findings. Do not post the review.",
    "",
    "1. Call gh_pr_context with repo=" + JSON.stringify(input.repo) + " and number=" + input.number + ". Read the " +
      "body, the file list and the existing review comments before judging anything; a review that repeats a settled " +
      "thread is noise.",
    "2. If a checkout is available at " + treeAt(input.worktree) + ", call git_status to check it matches this change, " +
      "then git_diff with mode=\"patch\" and path= to read the hunks that matter. Use git_log with path= when the " +
      "intent behind a hunk is unclear.",
    "3. Check, in this order: does the change do what the title and body claim; is the new behaviour covered by an " +
      "assertion that would fail without it; does it change a public interface, a default or an error message; what " +
      "happens on the failure path; does it leave debug output, a secret or a commented-out block behind.",
    "4. Report each finding as path:line - what is wrong - why it matters - what to change, ordered by severity, " +
      "then one line: no blocking findings, or N blocking findings.",
    "",
    "Do not approve, request changes or comment on GitHub. A human decides what to send.",
  ].join("\n");
}

/** The triage plan answers whether an issue still reproduces, with evidence rather than an opinion. */
export function triageIssuesText(input: { repo: string; query?: string; worktree?: string }): string {
  const query = input.query ?? "";
  return [
    "Triage open issues in " + input.repo + (query ? " matching " + JSON.stringify(query) : "") +
      " and report which ones still reproduce.",
    "",
    "1. Call gh_issue_search with repo=" + JSON.stringify(input.repo) + ", query=" + JSON.stringify(query) +
      ", state=\"open\", limit=10.",
    "2. Pick at most three issues that look actionable, and skip anything already assigned or already carrying a " +
      "pull request reference in its body.",
    "3. For each, look for evidence in the tree at " + treeAt(input.worktree) + ": git_log with path=<the path the " +
      "issue names>, limit=10, and git_status or git_diff when the issue describes a behaviour rather than a file.",
    "4. Classify each issue as fixed-in-history (name the commit), still-present (name file:line), or " +
      "needs-reporter-info (name the one question to ask), and say which one you would pick up first and why.",
    "",
    "Do not comment on GitHub, do not label anything, and do not open issues.",
  ].join("\n");
}

export interface PromptDefinition {
  name: string;
  title: string;
  description: string;
  argsSchema: Record<string, z.ZodTypeAny>;
  render: (args: Record<string, string | undefined>) => string;
}

export const PROMPTS: PromptDefinition[] = [
  {
    name: DIAGNOSE_CI,
    title: "Diagnose failing CI",
    description:
      "Diagnose a failing CI run: which check failed, the error line, and the file and commit behind it. Read-only, " +
      "and stops before proposing a patch.",
    argsSchema: diagnoseCiArgs,
    render: (args) => diagnoseCiText({ repo: args["repo"] ?? "", ref: args["ref"] ?? "", worktree: args["worktree"] }),
  },
  {
    name: REVIEW_PR,
    title: "Review a pull request",
    description:
      "Read a pull request context and diff, then report findings ordered by severity without posting anything " +
      "to GitHub.",
    argsSchema: reviewPrArgs,
    render: (args) =>
      reviewPrText({ repo: args["repo"] ?? "", number: args["number"] ?? "", worktree: args["worktree"] }),
  },
  {
    name: TRIAGE_ISSUES,
    title: "Triage open issues",
    description:
      "Search open issues, check each against the tree, and classify them as fixed, still present, or needing " +
      "more information.",
    argsSchema: triageIssuesArgs,
    render: (args) =>
      triageIssuesText({ repo: args["repo"] ?? "", query: args["query"], worktree: args["worktree"] }),
  },
];

/** Wrap a rendered plan in the shape get_prompt returns. */
export function promptResult(description: string, text: string): PromptText {
  return { description, messages: [{ role: "user", content: { type: "text", text } }] };
}
