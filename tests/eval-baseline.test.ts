import assert from "node:assert/strict";
import test from "node:test";

import { compareToBaseline, formatComparison, parseBaseline } from "../src/eval/baseline.js";
import type { CaseResult } from "../src/eval/run.js";

const RECORD = {
  model: "deepseek-flash",
  recorded_at: "2026-11-11",
  arm: "mcp",
  runs: 3,
  fixtures: {
    "alpha": "pass",
    "beta": "pass",
    "gamma": "fail",
  },
  summary: { cases: 3, passed: 2, successRate: 2 / 3 },
};

function result(id: string, success: boolean): CaseResult {
  return { fixture: { id }, score: { success } } as unknown as CaseResult;
}

test("parses a recorded baseline and keeps the per-fixture verdicts", () => {
  const record = parseBaseline(RECORD, "eval/baseline.json");
  assert.equal(record.model, "deepseek-flash");
  assert.equal(record.runs, 3);
  assert.deepEqual(record.fixtures, { alpha: "pass", beta: "pass", gamma: "fail" });
});

test("rejects a baseline that cannot be used as a gate", () => {
  assert.throws(() => parseBaseline(null, "b.json"), /must be a JSON object/);
  assert.throws(() => parseBaseline({ ...RECORD, model: "" }, "b.json"), /model must be/);
  assert.throws(() => parseBaseline({ ...RECORD, arm: "mcp " }, "b.json"), /arm must be/);
  assert.throws(() => parseBaseline({ ...RECORD, runs: 0 }, "b.json"), /runs must be/);
  assert.throws(
    () => parseBaseline({ ...RECORD, fixtures: { alpha: "ok" } }, "b.json"),
    /must be pass or fail/,
  );
  assert.throws(() => parseBaseline({ ...RECORD, fixtures: {} }, "b.json"), /must not be empty/);
});

test("a fixture the baseline solved and this run did not is a regression", () => {
  const record = parseBaseline(RECORD, "b.json");
  const comparison = compareToBaseline(record, [
    result("alpha", false),
    result("beta", true),
    result("gamma", false),
  ]);
  assert.equal(comparison.ok, false);
  assert.deepEqual(comparison.regressions, ["alpha"]);
  assert.deepEqual(comparison.recovered, []);
  assert.equal(comparison.measuredRate, 0.3333333333333333);
});

test("a fixture recovered against the baseline is reported, never a failure", () => {
  const record = parseBaseline(RECORD, "b.json");
  const comparison = compareToBaseline(record, [
    result("alpha", true),
    result("beta", true),
    result("gamma", true),
  ]);
  assert.equal(comparison.ok, true);
  assert.deepEqual(comparison.recovered, ["gamma"]);
  assert.equal(comparison.measuredRate, 1);
});

test("a fixture missing from the baseline fails the gate until it is re-recorded", () => {
  const record = parseBaseline(RECORD, "b.json");
  const comparison = compareToBaseline(record, [
    result("alpha", true),
    result("beta", true),
    result("gamma", false),
    result("delta", true),
  ]);
  assert.equal(comparison.ok, false);
  assert.deepEqual(comparison.unmeasured, ["delta"]);
  assert.match(formatComparison(record, comparison), /not in the baseline: delta/);
});

test("--max-regressions accepts a known regression and nothing more", () => {
  const record = parseBaseline(RECORD, "b.json");
  const one = [result("alpha", false), result("beta", true), result("gamma", false)];
  assert.equal(compareToBaseline(record, one, { maxRegressions: 1 }).ok, true);
  const two = [result("alpha", false), result("beta", false), result("gamma", false)];
  assert.equal(compareToBaseline(record, two).ok, false);
  assert.equal(compareToBaseline(record, two, { maxRegressions: 1 }).ok, false);
  assert.equal(compareToBaseline(record, two, { maxRegressions: 2 }).ok, true);
});

test("a recorded fixture this run never reached is reported, not silently dropped", () => {
  const record = parseBaseline(RECORD, "b.json");
  const comparison = compareToBaseline(record, [result("alpha", true), result("beta", true)]);
  assert.deepEqual(comparison.dropped, ["gamma"]);
  assert.equal(comparison.ok, true);
  assert.match(formatComparison(record, comparison), /recorded but not in this run: gamma/);
});

test("a run that measured nothing cannot pass the gate", () => {
  const record = parseBaseline(RECORD, "b.json");
  const comparison = compareToBaseline(record, []);
  assert.equal(comparison.ok, false);
  assert.equal(comparison.measuredRate, 0);
  assert.match(formatComparison(record, comparison), /nothing was measured/);
});

test("the comparison prints the gate, the model and the regressed fixtures", () => {
  const record = parseBaseline(RECORD, "b.json");
  const text = formatComparison(
    record,
    compareToBaseline(record, [result("alpha", false), result("beta", true), result("gamma", true)]),
  );
  assert.match(text, /gate: FAIL/);
  assert.match(text, /deepseek-flash \(mcp, 3 runs, 2026-11-11\)/);
  assert.match(text, /measured 66.7% now vs 66.7% recorded/);
  assert.match(text, /regressed: alpha/);
  assert.match(text, /recovered: gamma/);
  assert.match(text, /raise --max-regressions only on purpose/);
});