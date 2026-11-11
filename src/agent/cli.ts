#!/usr/bin/env node
/**
 * CLI for the reference agent: diagnose one red CI run and print the report.
 *
 *   node dist/agent/cli.js --repo acme/widget --ref main --worktree .
 *
 * Progress goes to stderr and the report to stdout, so the report can be piped
 * into a file or another tool while a person watches the run.
 */

import { parseArgs } from "node:util";
import { runDiagnose } from "./diagnose.js";
import { describeRun, type AgentEvent } from "./loop.js";
import { ProviderError, providerFromEnv } from "./provider.js";

const USAGE = [
  "Usage: mcp-repo-devtools-agent --repo <owner/name> [options]",
  "",
  "  --repo <owner/name>   repository to diagnose (required)",
  "  --ref <ref>           branch, tag or sha whose latest run failed",
  "  --pr <number>         diagnose the run attached to a pull request instead",
  "  --worktree <path>     local checkout for the read-only git tools",
  "  --model <name>        model to call (default: OPENAI_MODEL or gpt-4o-mini)",
  "  --base-url <url>      OpenAI-compatible endpoint (default: OPENAI_BASE_URL)",
  "  --max-turns <n>       hard stop after n model turns (default: 8)",
  "  --json                print the whole run as JSON on stdout",
  "  -h, --help            this text",
  "",
  "Environment: OPENAI_API_KEY (required), OPENAI_BASE_URL, OPENAI_MODEL,",
  "GITHUB_TOKEN, MCP_ALLOWED_ROOTS. The run is always read-only.",
].join("\n");

function fail(message: string): never {
  process.stderr.write(message + "\n\n" + USAGE + "\n");
  process.exit(2);
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 ? (bytes / 1024).toFixed(1) + " KB" : String(bytes) + " B";
}

function progress(event: AgentEvent): void {
  if (event.type === "turn") {
    process.stderr.write("[turn " + String(event.turn) + "]\n");
  } else if (event.type === "tool") {
    process.stderr.write("  -> " + event.name + " " + JSON.stringify(event.arguments) + "\n");
  } else if (event.type === "result") {
    const status = event.isError ? "error" : "ok";
    process.stderr.write("  <- " + status + " " + formatBytes(event.bytes) + "\n");
  } else if (event.type === "limit") {
    process.stderr.write("  ! " + event.reason + "\n");
  }
}

async function main(): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        repo: { type: "string" },
        ref: { type: "string" },
        pr: { type: "string" },
        worktree: { type: "string" },
        model: { type: "string" },
        "base-url": { type: "string" },
        "max-turns": { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: false,
      strict: true,
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  if (parsed.values.help === true) {
    process.stdout.write(USAGE + "\n");
    return 0;
  }
  const repo = parsed.values.repo;
  if (repo === undefined || repo.trim().length === 0) {
    fail("--repo is required");
  }

  let maxTurns: number | undefined;
  if (parsed.values["max-turns"] !== undefined) {
    maxTurns = Number(parsed.values["max-turns"]);
    if (!Number.isInteger(maxTurns) || maxTurns < 1) {
      fail("--max-turns must be a positive integer");
    }
  }
  let pullRequest: number | undefined;
  if (parsed.values.pr !== undefined) {
    pullRequest = Number(parsed.values.pr);
    if (!Number.isInteger(pullRequest) || pullRequest < 1) {
      fail("--pr must be a positive integer");
    }
  }
  if (parsed.values.ref !== undefined && pullRequest !== undefined) {
    fail("--ref and --pr are alternatives; pass one");
  }

  let provider;
  try {
    provider = providerFromEnv(process.env, {
      baseUrl: parsed.values["base-url"],
      model: parsed.values.model,
    });
  } catch (error) {
    if (error instanceof ProviderError) {
      fail(error.message);
    }
    throw error;
  }

  const controller = new AbortController();
  process.once("SIGINT", () => {
    controller.abort();
  });

  const run = await runDiagnose({
    provider,
    target: {
      repo,
      ref: parsed.values.ref,
      pullRequest,
      worktree: parsed.values.worktree,
    },
    limits: maxTurns === undefined ? undefined : { maxTurns },
    signal: controller.signal,
    onEvent: parsed.values.json === true ? undefined : progress,
  });

  if (parsed.values.json === true) {
    process.stdout.write(JSON.stringify(run, null, 2) + "\n");
  } else {
    const text = run.text.trim();
    process.stdout.write((text.length > 0 ? text : "No report was produced.") + "\n");
    process.stderr.write(describeRun(run) + "\n");
  }
  return run.stopReason === "final" ? 0 : 3;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write("agent failed: " + (error instanceof Error ? error.message : String(error)) + "\n");
    process.exitCode = 1;
  });
