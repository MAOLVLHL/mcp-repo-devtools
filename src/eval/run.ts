/**
 * One case: bake the fixture, run the loop against one of the two tool surfaces,
 * and grade what came back. No network, no second model, no wall-clock scoring.
 */

import { runAgent, type AgentEvent, type AgentLimits, type AgentRun } from "../agent/loop.js";
import { callTool, connectInProcess } from "../agent/mcp-tools.js";
import type { Provider } from "../agent/provider.js";
import { buildRepo, type BuiltRepo, type Fixture } from "./fixture.js";
import { installGithubStub } from "./github-fixture.js";
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
  "You are investigating a failing test. The repository is checked out locally; a CI run",
  "may or may not be reachable through the tools you were given.",
  "You have read-only tools. Nothing you do can change the repository, and nothing you do",
  "is deployed anywhere.",
  "",
  "Work from evidence. Read the history, read the diffs, and name the commit whose change",
  "explains the failure. A plausible story without a diff behind it is a wrong answer even",
  "when it sounds right. If the history genuinely does not identify a commit, say that",
  "instead of inventing a sha.",
  "",
  "Cite the sha exactly as the history printed it, abbreviated or not. Never pad a short sha",
  "into a longer one: the rest of those characters would be invented.",
].join("\n");

export function taskPrompt(fixture: Fixture, build: BuiltRepo, arm: Arm): string {
  const symptom = fixture.symptom
    .split("\n")
    .map((line) => "  " + line)
    .join("\n");
  const github = build.github ?? fixture.github;
  if (github !== undefined) {
    const tools =
      arm === "mcp"
        ? [
            "Tools: gh_ci_failures(repo, ref, include_logs) reads the CI run on GitHub;",
            "git_log and git_diff read the checkout at " + build.repo + ".",
          ].join("\n")
        : "The only tool is git, and it can read this checkout but not GitHub. No workflow log is on disk.";
    const history = build.shallow
      ? [
          "The checkout is at " + build.repo + ", a depth-1 clone of the commit the workflow",
          "tested: one commit, no parent, no earlier history on disk. The change that broke the",
          "test is older than that commit and its history was never fetched, so the job log is",
          "the only place it is still named.",
        ].join("\n")
      : "The checkout is at " + build.repo + ".";
    return [
      "CI is failing on " + github.repo + " at " + github.ref + ".",
      "",
      symptom,
      "",
      history,
      "The workflow run is " + String(github.run) + "; the failing job's log is on GitHub.",
      tools,
      "",
      "Find the commit that introduced this regression, then answer with exactly these two",
      "sections:",
      "",
      "## Introduced by",
      "<the commit sha, exactly as the history printed it>",
      "",
      "## Why",
      "<at most 150 words: what that commit changed, and which failing step or error says so>",
      "",
      "Do not modify files. Do not guess: if the evidence does not identify a commit, say so",
      "in the Why section and leave Introduced by empty.",
    ].join("\n");
  }
  const tools =
    arm === "mcp"
      ? "Tools: git_log, git_diff, git_status. They take an absolute repo path."
      : "The only tool is git: pass arguments such as 'log --oneline -n 10' or 'show <sha>'.";
  return [
    "A test is failing.",
    "",
    symptom,
    "",
    "The repository is checked out at " + build.repo + ". Its history is the evidence.",
    tools,
    "",
    "Find the commit that introduced this regression, then answer with exactly these two",
    "sections:",
    "",
    "## Introduced by",
    "<the commit sha, exactly as the history printed it>",
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
  // The stub is installed for both arms: the raw arm has no GitHub tool, so it never
  // reaches the network, and the score shows exactly that.
  const stub = build.github === undefined ? null : installGithubStub(build.github);

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
      stub?.restore();
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

  stub?.restore();
  return { fixture, build, run, score: gradeRun(fixture, build.expectedSha, build.shas, run) };
}