/**
 * What a tool says about itself before it is called: does it read or write,
 * is a second call safe, does it leave this machine. A host can use these to
 * label, group or hide tools without reading prose.
 *
 * They are hints, not permissions: the protocol tells clients not to make
 * security decisions from them, and the real control lives in the registry —
 * write tools are not registered at all unless MCP_ENABLE_WRITE=1.
 */

import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/** Reads a local checkout: no network, no writes, same answer twice. */
export const LOCAL_READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const satisfies ToolAnnotations;

/** Reads GitHub: no writes, safe to repeat, but it talks to a system we do not own. */
export const REMOTE_READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const satisfies ToolAnnotations;

/** Creates a PR, an issue or a comment: not read-only, and repeating it is not free. */
export const REMOTE_WRITE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const satisfies ToolAnnotations;

/**
 * Sent once, at initialize. Short on purpose: every tool description already
 * says what it does, so this is only the part that spans tools.
 */
export const SERVER_INSTRUCTIONS = [
  "This server reads git repositories inside MCP_ALLOWED_ROOTS and, with a GITHUB_TOKEN, public GitHub data.",
  "Start with git_status to see what changed, then git_log or git_diff on the paths that matter.",
  "Every result is capped at 64 KB / 200 lines; when a result ends with a truncation note, narrow the query instead of repeating it.",
  "Write tools (gh_pr_create, gh_issue_create, gh_pr_comment) exist only when the server was started with MCP_ENABLE_WRITE=1.",
  "Nothing here runs a shell, pushes, merges or edits files.",
].join(" ");
