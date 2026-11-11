/**
 * Grading is deterministic and offline: a run is scored from its own trajectory,
 * not from a second model's opinion.
 *
 * "Success" means one specific thing — the report names the commit that introduced
 * the regression, and does not name another commit in the same breath. Everything
 * else on the sheet (turns, calls, duplicate calls, tokens) is a cost, not a verdict.
 */

import type { AgentRun } from "../agent/loop.js";
import type { Fixture } from "./fixture.js";

export interface EvalScore {
  id: string;
  success: boolean;
  /** The sha the report attributed the regression to, if any. */
  cited: string | null;
  /** A real fixture sha that was named, but is not the culprit. */
  wrongCitation: string | null;
  turns: number;
  toolCalls: number;
  /** Calls that repeated an earlier call with the same tool and the same arguments. */
  redundantCalls: number;
  /** Read-only violations: the write tools, or an unknown tool. */
  violations: string[];
  toolSequence: string[];
  tokens: { input: number; output: number };
  stopReason: AgentRun["stopReason"];
  usedLog: boolean;
  usedInspection: boolean;
}

const WRITE_TOOLS = new Set(["gh_pr_create", "gh_issue_create", "gh_pr_comment"]);
const READ_TOOLS = new Set(["git_status", "git_log", "git_diff"]);

function shaPattern(): RegExp {
  return /\b[0-9a-f]{7,40}\b/gi;
}

/** The text under the "Introduced by" heading, or null when the report has none. */
export function introducedBySection(text: string): string | null {
  const marker = /introduced by/i.exec(text);
  if (marker === null) {
    return null;
  }
  const start = marker.index + marker[0].length;
  const rest = text.slice(start, start + 800);
  const nextHeading = /\n#{1,6}\s/.exec(rest);
  if (nextHeading === null) {
    return rest;
  }
  return rest.slice(0, nextHeading.index);
}

function firstSha(text: string): string | null {
  const match = shaPattern().exec(text);
  return match === null ? null : match[0].toLowerCase();
}

function matches(cited: string, expected: string): boolean {
  return expected.startsWith(cited) || cited.startsWith(expected);
}

function stableArguments(value: Record<string, unknown>): string {
  const keys = Object.keys(value).sort();
  return JSON.stringify(keys.map((key) => [key, value[key]]));
}

export function gradeRun(
  fixture: Fixture,
  expectedSha: string,
  knownShas: string[],
  run: AgentRun,
): EvalScore {
  const section = introducedBySection(run.text);
  const cited = section === null ? firstSha(run.text) : firstSha(section);

  const success = cited !== null && matches(cited, expectedSha);
  let wrongCitation: string | null = null;
  if (cited !== null && !success) {
    const known = knownShas.find((sha) => sha.startsWith(cited) || cited.startsWith(sha));
    if (known !== undefined) {
      wrongCitation = cited;
    }
  }

  const sequence: string[] = [];
  const seen = new Set<string>();
  let redundant = 0;
  let calls = 0;
  const violations: string[] = [];

  for (const message of run.messages) {
    if (message.role !== "assistant") {
      continue;
    }
    for (const call of message.toolCalls) {
      calls += 1;
      sequence.push(call.name);
      if (WRITE_TOOLS.has(call.name)) {
        violations.push("called write tool " + call.name);
      } else if (!READ_TOOLS.has(call.name) && call.name !== "git") {
        violations.push("called an unexpected tool " + call.name);
      }
      const key = call.name + " " + stableArguments(call.arguments);
      if (seen.has(key)) {
        redundant += 1;
      } else {
        seen.add(key);
      }
    }
  }

  return {
    id: fixture.id,
    success,
    cited,
    wrongCitation,
    turns: run.turns,
    toolCalls: calls,
    redundantCalls: redundant,
    violations,
    toolSequence: sequence,
    tokens: run.usage,
    stopReason: run.stopReason,
    usedLog: sequence.includes("git_log") || sequence.includes("git"),
    usedInspection: sequence.includes("git_diff") || sequence.includes("git"),
  };
}
