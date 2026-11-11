/**
 * A recorded run is the only honest gate a stochastic system can have.
 *
 * A model is allowed to be noisy; a fixture it solved when the baseline was
 * recorded is not allowed to stop being solved without someone saying so in the
 * pull request. The record is a per-fixture verdict, not an average, because an
 * average hides a swap: one fixture recovered and another lost still reads 87%.
 */

import type { CaseResult, Arm } from "./run.js";

export type Verdict = "pass" | "fail";

export interface BaselineRecord {
  /** The model the numbers belong to, e.g. "deepseek-flash". */
  model: string;
  /** ISO date of the recording, so a stale gate is visible. */
  recorded_at: string;
  arm: Arm;
  /** How many runs the verdicts were taken from; the majority wins. */
  runs: number;
  /** Per fixture, the verdict the majority of those runs produced. */
  fixtures: Record<string, Verdict>;
  /** The recorded aggregate, for the summary line only; never used as a gate. */
  summary: { cases: number; passed: number; successRate: number };
}

export interface BaselineComparison {
  ok: boolean;
  /** Recorded as passing, failing now. These are the gate. */
  regressions: string[];
  /** Recorded as failing, passing now: worth reporting, never a failure. */
  recovered: string[];
  /** Not in the record at all — a fixture added after it was taken. */
  unmeasured: string[];
  /** In the record but not in this run — a removed fixture, or a narrowed --fixtures. */
  dropped: string[];
  /** Success rate over the fixtures the record knows about. */
  measuredRate: number;
  recordedRate: number;
  allowed: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseBaseline(value: unknown, source: string): BaselineRecord {
  const record = asRecord(value);
  if (record === null) {
    throw new Error(source + ": a baseline must be a JSON object");
  }
  const model = record["model"];
  const recordedAt = record["recorded_at"];
  const arm = record["arm"];
  const runs = record["runs"];
  if (typeof model !== "string" || model.trim().length === 0) {
    throw new Error(source + ": model must be a non-empty string");
  }
  if (typeof recordedAt !== "string" || recordedAt.trim().length === 0) {
    throw new Error(source + ": recorded_at must be a non-empty string");
  }
  if (arm !== "mcp" && arm !== "baseline") {
    throw new Error(source + ": arm must be mcp or baseline");
  }
  if (typeof runs !== "number" || !Number.isInteger(runs) || runs < 1) {
    throw new Error(source + ": runs must be a positive integer");
  }
  const rawFixtures = asRecord(record["fixtures"]);
  if (rawFixtures === null) {
    throw new Error(source + ": fixtures must be an object");
  }
  const fixtures: Record<string, Verdict> = {};
  for (const [id, verdict] of Object.entries(rawFixtures)) {
    if (verdict !== "pass" && verdict !== "fail") {
      throw new Error(source + ": fixture " + id + " must be pass or fail");
    }
    fixtures[id] = verdict;
  }
  if (Object.keys(fixtures).length === 0) {
    throw new Error(source + ": fixtures must not be empty");
  }
  const summary = asRecord(record["summary"]) ?? {};
  const cases = typeof summary["cases"] === "number" ? summary["cases"] : Object.keys(fixtures).length;
  const passed = typeof summary["passed"] === "number" ? summary["passed"] : 0;
  const rate = typeof summary["successRate"] === "number" ? summary["successRate"] : 0;
  return {
    model,
    recorded_at: recordedAt,
    arm,
    runs,
    fixtures,
    summary: { cases, passed, successRate: rate },
  };
}

export interface CompareOptions {
  /** Regressions a caller is willing to accept. Raising it is an admission, not a fix. */
  maxRegressions?: number;
}

/**
 * Compare one run against the record. The gate is the regression list; the rate is
 * printed beside it so a swap is visible even when the totals match.
 */
export function compareToBaseline(
  record: BaselineRecord,
  results: CaseResult[],
  options: CompareOptions = {},
): BaselineComparison {
  const allowed = options.maxRegressions ?? 0;
  const regressions: string[] = [];
  const recovered: string[] = [];
  const unmeasured: string[] = [];
  const seen = new Set<string>();
  let measured = 0;
  let passed = 0;

  for (const result of results) {
    const id = result.fixture.id;
    seen.add(id);
    const recorded = record.fixtures[id];
    if (recorded === undefined) {
      unmeasured.push(id);
      continue;
    }
    measured += 1;
    if (result.score.success) {
      passed += 1;
      if (recorded === "fail") {
        recovered.push(id);
      }
    } else if (recorded === "pass") {
      regressions.push(id);
    }
  }

  const dropped = Object.keys(record.fixtures).filter((id) => !seen.has(id));

  return {
    // An empty run cannot pass: zero measured fixtures means the gate guarded nothing.
    ok: measured > 0 && regressions.length <= allowed && unmeasured.length === 0,
    regressions,
    recovered,
    unmeasured,
    dropped,
    measuredRate: measured === 0 ? 0 : passed / measured,
    recordedRate: record.summary.successRate,
    allowed,
  };
}

function percent(value: number): string {
  return String(Math.round(value * 1000) / 10) + "%";
}

export function formatComparison(record: BaselineRecord, comparison: BaselineComparison): string {
  const lines = [
    "gate: " +
      (comparison.ok ? "pass" : "FAIL") +
      "  ·  " +
      record.model +
      " (" +
      record.arm +
      ", " +
      String(record.runs) +
      " runs, " +
      record.recorded_at +
      ")",
    "measured " +
      percent(comparison.measuredRate) +
      " now vs " +
      percent(comparison.recordedRate) +
      " recorded  ·  " +
      String(comparison.regressions.length) +
      " regression(s), " +
      String(comparison.recovered.length) +
      " recovered, " +
      String(comparison.unmeasured.length) +
      " unmeasured",
  ];
  if (comparison.regressions.length > 0) {
    lines.push("regressed: " + comparison.regressions.join(", "));
  }
  if (comparison.regressions.length > comparison.allowed) {
    lines.push(
      "the recorded baseline solved " +
        String(comparison.regressions.length) +
        " of these and this run did not; raise --max-regressions only on purpose",
    );
  }
  if (comparison.recovered.length > 0) {
    lines.push("recovered: " + comparison.recovered.join(", "));
  }
  if (comparison.measuredRate === 0) {
    lines.push("nothing was measured: a gate cannot pass on an empty run");
  }
  if (comparison.dropped.length > 0) {
    lines.push(
      "recorded but not in this run: " +
        comparison.dropped.join(", ") +
        " — re-record if they were removed",
    );
  }
  if (comparison.unmeasured.length > 0) {
    lines.push(
      "not in the baseline: " +
        comparison.unmeasured.join(", ") +
        " — re-record it with npm run eval:record",
    );
  }
  return lines.join("\n");
}