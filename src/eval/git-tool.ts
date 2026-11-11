/**
 * The baseline arm: one tool that runs git and returns whatever it prints.
 *
 * This is the good version of what an agent does without this server — no
 * truncation, no shaping, no summary. It exists so a benchmark can compare a
 * tool surface against a shell, instead of comparing a tool surface against
 * nothing.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { AgentToolbox } from "../agent/mcp-tools.js";
import type { ToolCall, ToolSpec } from "../agent/provider.js";
import { clip } from "../text.js";

const run = promisify(execFile);

/** Read-only git commands; the baseline must not be able to rewrite the fixture. */
export const BASELINE_SUBCOMMANDS = new Set([
  "log",
  "show",
  "diff",
  "status",
  "rev-list",
  "rev-parse",
  "branch",
  "blame",
  "cat-file",
  "show-ref",
  "tag",
]);

export const BASELINE_TOOL = "git";

export interface RawGitOptions {
  timeoutMs?: number;
  maxBytes?: number;
}

/** Split a command line the way a shell would for the simple cases a model writes. */
export function splitArguments(input: string): string[] {
  const parts: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(input)) !== null) {
    parts.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return parts;
}

export function rawGitToolbox(repo: string, options: RawGitOptions = {}): AgentToolbox {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxBytes = options.maxBytes ?? 64 * 1024;
  const spec: ToolSpec = {
    name: BASELINE_TOOL,
    description:
      "Run a git command in the repository and return its output verbatim. " +
      "Pass the arguments after git, for example 'log --oneline -n 10' or 'show <sha>'.",
    inputSchema: {
      type: "object",
      properties: {
        args: { type: "string", description: "Arguments after git, e.g. 'log --oneline -n 10'" },
      },
      required: ["args"],
    },
  };

  return {
    specs: [spec],
    async call(call: ToolCall) {
      if (call.argumentsError !== undefined) {
        return { text: "The call was not executed: " + call.argumentsError, isError: true };
      }
      const raw = call.arguments["args"];
      const args = typeof raw === "string" ? splitArguments(raw) : [];
      const subcommand = args[0];
      if (subcommand === undefined) {
        return { text: "The call was not executed: args was empty.", isError: true };
      }
      if (!BASELINE_SUBCOMMANDS.has(subcommand)) {
        return {
          text: "The baseline runs read-only git commands; " + subcommand + " is not one of them.",
          isError: true,
        };
      }
      try {
        const result = await run("git", args, {
          cwd: repo,
          timeout: timeoutMs,
          maxBuffer: 8 * 1024 * 1024,
          env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
        });
        return { text: clip(String(result.stdout), { maxBytes, maxLines: 2000 }), isError: false };
      } catch (error) {
        const stderr =
          error !== null && typeof error === "object" && "stderr" in error ? String(error.stderr) : "";
        const message = error instanceof Error ? error.message : String(error);
        return { text: "git " + args.join(" ") + " failed: " + (stderr.trim() || message), isError: true };
      }
    },
  };
}
