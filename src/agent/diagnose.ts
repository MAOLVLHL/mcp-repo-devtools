/**
 * One task, defined once: why is CI red, which commit did it, what now.
 *
 * The prompt is the contract: evidence before prose, read-only, a cause named
 * only when the evidence names it, and a report short enough that a reviewer
 * actually reads it. The loop and the CLI only carry it out.
 */

import type { ServerOptions } from "../server.js";
import { runAgent, type AgentEvent, type AgentLimits, type AgentRun } from "./loop.js";
import { callTool, connectInProcess } from "./mcp-tools.js";
import type { Provider } from "./provider.js";

export const DIAGNOSE_SYSTEM_PROMPT = [
  "You are a release engineer diagnosing a red CI run and writing the report a teammate will act on.",
  "",
  "Rules:",
  "- Gather evidence with the tools before writing anything. Start with gh_ci_failures for the ref and include_logs: true — the log is kept around the first error, so one call carries the failure.",
  "- Then use git_log and pull-request context to find what changed. Cite a commit the way the tool printed it: seven characters are a citation, invented padding is not.",
  "- This run is read-only. Never modify files, and never open, comment on, push or merge anything, even if a tool exists for it.",
  "- Every claim must cite evidence you actually saw: a job name, a commit hash, a file path, an error line. Do not guess.",
  "- If the evidence does not identify a cause, say so and name the check that would settle it.",
  "- Finish with the report only, at most 200 words, under these headings: What failed / Why / Introduced by / Next step.",
].join("\n");

export interface DiagnoseTarget {
  repo: string;
  ref?: string;
  pullRequest?: number;
  /** Local checkout the read-only git tools run against. */
  worktree?: string;
}

export function diagnoseTask(target: DiagnoseTarget): string {
  const lines = ["Repository: " + target.repo];
  if (target.pullRequest !== undefined) {
    lines.push("Pull request: #" + String(target.pullRequest));
  }
  if (target.ref !== undefined) {
    lines.push("Ref: " + target.ref);
  }
  if (target.worktree !== undefined) {
    lines.push("Local worktree: " + target.worktree);
  }
  lines.push(
    "",
    "The latest CI run on this ref is failing. Find the failing job, the first error that explains it, and the commit that introduced it.",
    "Write the report described in your instructions.",
  );
  return lines.join("\n");
}

export interface DiagnoseOptions {
  provider: Provider;
  target: DiagnoseTarget;
  /** Server options; write mode is always off for this task. */
  server?: ServerOptions;
  limits?: AgentLimits;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
}

/**
 * Run the task end to end: connect to the server in process, run the loop,
 * always disconnect. The server stays read-only by construction, so a model
 * that ignores the instruction still has nothing to push with.
 */
export async function runDiagnose(options: DiagnoseOptions): Promise<AgentRun> {
  const server = await connectInProcess({ ...options.server, enableWrite: false });
  try {
    return await runAgent({
      provider: options.provider,
      toolbox: {
        specs: server.specs,
        call: (call, maxBytes) => callTool(server.client, call, maxBytes),
      },
      system: DIAGNOSE_SYSTEM_PROMPT,
      task: diagnoseTask(options.target),
      limits: options.limits,
      signal: options.signal,
      onEvent: options.onEvent,
    });
  } finally {
    await server.close();
  }
}
