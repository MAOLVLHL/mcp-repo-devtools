/**
 * One case: bake the fixture, run the loop against one of the two tool surfaces,
 * and grade what came back. No network, no second model, no wall-clock scoring.
 */

import { runAgent, type AgentEvent, type AgentLimits, type AgentRun } from "../agent/loop.js";
import { callTool, connectInProcess } from "../agent/mcp-tools.js";
import type { Provider } from "../agent/provider.js";
import { buildRepo, type BuiltRepo, type Fixture } from "./fixture.js";
import { rawGitToolbox } from "./git-tool.js";
import { gradeRun, type EvalScore } from "./grade.js";

/** The two arms: the server's tools, or a single raw git command runner. */
export type Arm = "mcp" | "baseline";

export interface CaseOptions {
  arm: Arm;
  /** Called after the repository exists, so a scripted provider can cite its shas. */
  providerFor: (context: BuiltRepo) => Provider;
  limits?: AgentLimits;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
}

export interface CaseResult {
  fixture: Fixture;
  build: BuiltRepo;
  run: AgentRun;
  score: EvalScore;
}

export const EVAL_SYSTEM_PROMPT = [
  "You are investigating a failing test in a local git repository.",
  "You have read-only tools. Nothing you do can change the repository, and nothing you do",
  "is deployed anywhere.",
  "",
  "Work from evidence. Read the history, read the diffs, and name the commit whose change",
  "explains the failure. A plausible story without a diff behind it is a wrong answer even",
  "when it sounds right. If the history genuinely does not identify a commit, say that",
  "instead of inventing a sha.",
].join("\n");

export function taskPrompt(fixture: Fixture, build: BuiltRepo, arm: Arm): string {
  const tools =
    arm === "mcp"
      ? "Tools: git_log, git_diff, git_status. They take an absolute repo path."
      : "The only tool is git: pass arguments such as 'log --oneline -n 10' or 'show <sha>'.";
  return [
    "A test is failing.",
    "",
    fixture.symptom
      .split("\n")
      .map((line) => "  " + line)
      .join("\n"),
    "",
    "The repository is checked out at " + build.repo + ". Its history is the evidence.",
    tools,
    "",
    "Find the commit that introduced this regression, then answer with exactly these two",
    "sections:",
    "",
    "## Introduced by",
    "<the full commit sha>",
    "",
    "## Why",
    "<at most 150 words: what that commit changed and why it breaks this test>",
    "",
    "Do not modify files. Do not guess: if the history does not identify a commit, say so",
    "in the Why section and leave Introduced by empty.",
  ].join("\n");
}

export async function runCase(fixture: Fixture, root: string, options: CaseOptions): Promise<CaseResult> {
  const build = await buildRepo(fixture, root);
  const provider = options.providerFor(build);
  const system = EVAL_SYSTEM_PROMPT;
  const task = taskPrompt(fixture, build, options.arm);

  let run: AgentRun;
  if (options.arm === "mcp") {
    const connection = await connectInProcess({ allowedRoots: [build.repo] });
    try {
      run = await runAgent({
        provider,
        system,
        task,
        toolbox: {
          specs: connection.specs,
          call: (call, maxBytes) => callTool(connection.client, call, maxBytes),
        },
        limits: options.limits,
        signal: options.signal,
        onEvent: options.onEvent,
      });
    } finally {
      await connection.close();
    }
  } else {
    run = await runAgent({
      provider,
      system,
      task,
      toolbox: rawGitToolbox(build.repo),
      limits: options.limits,
      signal: options.signal,
      onEvent: options.onEvent,
    });
  }

  return { fixture, build, run, score: gradeRun(fixture, build.expectedSha, build.shas, run) };
}
