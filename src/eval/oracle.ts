/**
 * A scripted "oracle" trajectory: log, then the right diff, then the report.
 *
 * It proves the harness, not the model. If a fixture is malformed, a tool is
 * misnamed or the grader is wrong, the oracle scores below 1.0 and CI fails —
 * which is the point of running it before spending tokens on a real model.
 */

import type { ScriptedTurn } from "../agent/provider.js";
import type { BuiltRepo, Fixture } from "./fixture.js";
import type { Arm } from "./run.js";

function parentOf(fixture: Fixture, build: BuiltRepo): string {
  const parent = build.shas[fixture.expected_commit - 2];
  return parent ?? build.expectedSha;
}

export function oracleTurns(fixture: Fixture, build: BuiltRepo, arm: Arm): ScriptedTurn[] {
  const parent = parentOf(fixture, build);
  const github = fixture.github;
  if (github !== undefined && arm === "mcp") {
    // The typed arm is allowed to read the CI run; that is the whole difference.
    return [
      {
        text: "",
        toolCalls: [
          {
            id: "c1",
            name: "gh_ci_failures",
            arguments: { repo: github.repo, ref: github.ref, include_logs: true, log_lines: 60 },
          },
        ],
      },
      { text: "", toolCalls: [{ id: "c2", name: "git_log", arguments: { repo: build.repo, limit: 10 } }] },
      {
        text:
          "## Introduced by\n" +
          build.expectedSha +
          "\n\n## Why\nThe failing job's log names the broken behaviour, and this commit" +
          " changed exactly that code; the fixture asserts the failure.",
        toolCalls: [],
      },
    ];
  }
  if (github !== undefined) {
    // A git command cannot read a workflow log. Reporting no commit is the honest
    // answer, and the arm is graded as not having solved the case.
    return [
      { text: "", toolCalls: [{ id: "c1", name: "git", arguments: { args: "log --oneline -n 10" } }] },
      {
        text:
          "## Introduced by\n\n## Why\nThe failure is only described in a CI log, which a git" +
          " command cannot reach; the checkout alone does not identify a commit.",
        toolCalls: [],
      },
    ];
  }
  const log =
    arm === "mcp"
      ? { text: "", toolCalls: [{ id: "c1", name: "git_log", arguments: { repo: build.repo, limit: 10 } }] }
      : { text: "", toolCalls: [{ id: "c1", name: "git", arguments: { args: "log --oneline -n 10" } }] };
  const diff =
    arm === "mcp"
      ? {
          text: "",
          toolCalls: [
            {
              id: "c2",
              name: "git_diff",
              arguments: { repo: build.repo, base: parent, mode: "patch" },
            },
          ],
        }
      : { text: "", toolCalls: [{ id: "c2", name: "git", arguments: { args: "show " + build.expectedSha } }] };
  const report = {
    text:
      "## Introduced by\n" +
      build.expectedSha +
      "\n\n## Why\nThe diff for this commit is the change that broke the test; the fixture" +
      " asserts exactly that behaviour.",
    toolCalls: [],
  };
  return [log, diff, report];
}