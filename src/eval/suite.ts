/**
 * The sheet: one row per case, and the four numbers a claim about an agent needs
 * — did it get the answer, what did it cost, did it repeat itself, did it break
 * the read-only rule.
 */

import type { CaseResult } from "./run.js";

export interface SuiteSummary {
  cases: number;
  passed: number;
  successRate: number;
  avgTurns: number;
  avgToolCalls: number;
  avgTokens: number;
  redundantRate: number;
  violations: number;
}

function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((total, value) => total + value, 0) / values.length;
}

export function summarize(results: CaseResult[]): SuiteSummary {
  const passed = results.filter((result) => result.score.success).length;
  const calls = results.map((result) => result.score.toolCalls);
  const totalCalls = calls.reduce((total, value) => total + value, 0);
  const redundant = results.reduce((total, result) => total + result.score.redundantCalls, 0);
  return {
    cases: results.length,
    passed,
    successRate: results.length === 0 ? 0 : passed / results.length,
    avgTurns: mean(results.map((result) => result.score.turns)),
    avgToolCalls: mean(calls),
    avgTokens: mean(results.map((result) => result.score.tokens.input + result.score.tokens.output)),
    redundantRate: totalCalls === 0 ? 0 : redundant / totalCalls,
    violations: results.reduce((total, result) => total + result.score.violations.length, 0),
  };
}

function tokens(result: CaseResult): number {
  return result.score.tokens.input + result.score.tokens.output;
}

/** A suite is one arm over both kinds of fixture; the report keeps them apart. */
export interface KindSummary {
  kind: string;
  summary: SuiteSummary;
}

export function summarizeByKind(results: CaseResult[]): KindSummary[] {
  const kinds = [...new Set(results.map((result) => result.fixture.kind))].sort();
  return kinds.map((kind) => ({
    kind,
    summary: summarize(results.filter((result) => result.fixture.kind === kind)),
  }));
}

export function formatKinds(kinds: KindSummary[]): string {
  if (kinds.length < 2) {
    return "";
  }
  return kinds
    .map(
      (entry) =>
        entry.kind +
        " fixtures: " +
        String(entry.summary.passed) +
        "/" +
        String(entry.summary.cases) +
        " (" +
        String(Math.round(entry.summary.successRate * 1000) / 10) +
        "%)",
    )
    .join("  ·  ");
}

export function formatTable(results: CaseResult[]): string {
  const lines = [
    "| Fixture | Kind | Result | Cited | Turns | Calls | Duplicates | Tokens |",
    "| --- | --- | --- | --- | ---: | ---: | ---: | ---: |",
  ];
  for (const result of results) {
    const score = result.score;
    const cited = score.cited === null ? "-" : score.cited.slice(0, 9);
    lines.push(
      "| " +
        result.fixture.id +
        " | " +
        result.fixture.kind +
        " | " +
        (score.success ? "pass" : "fail") +
        " | " +
        cited +
        " | " +
        String(score.turns) +
        " | " +
        String(score.toolCalls) +
        " | " +
        String(score.redundantCalls) +
        " | " +
        String(tokens(result)) +
        " |",
    );
  }
  return lines.join("\n");
}

export function formatSummary(summary: SuiteSummary): string {
  return [
    "success@1 " +
      String(summary.passed) +
      "/" +
      String(summary.cases) +
      " (" +
      String(Math.round(summary.successRate * 1000) / 10) +
      "%)",
    "avg turns " + summary.avgTurns.toFixed(2),
    "avg calls " + summary.avgToolCalls.toFixed(2),
    "avg tokens " + String(Math.round(summary.avgTokens)),
    "duplicate calls " + String(Math.round(summary.redundantRate * 1000) / 10) + "%",
    "read-only violations " + String(summary.violations),
  ].join("  ·  ");
}