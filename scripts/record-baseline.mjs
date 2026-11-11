#!/usr/bin/env node
/**
 * Turn N recorded runs into the baseline the gate compares against.
 *
 * A single run is a coin flip; three runs and a majority is a verdict. The
 * script refuses to invent a verdict for a fixture some run never reached,
 * because a missing case silently narrows the gate.
 *
 *   node scripts/record-baseline.mjs eval/baseline.json run-1.json run-2.json run-3.json
 */

import { readFileSync, writeFileSync } from "node:fs";

import { parseBaseline } from "../dist/eval/baseline.js";

const args = process.argv.slice(2);
const output = args.shift();
if (output === undefined || args.length === 0) {
  console.error("usage: record-baseline.mjs <out.json> <run.json> [run.json ...]");
  process.exit(2);
}

const model = process.env.OPENAI_MODEL ?? "unrecorded-model";
const verdicts = new Map();
let arm = null;
let provider = null;

for (const file of args) {
  const payload = JSON.parse(readFileSync(file, "utf8"));
  arm = payload.arm ?? arm;
  provider = payload.provider ?? provider;
  const results = Array.isArray(payload.results) ? payload.results : [];
  if (results.length === 0) {
    console.error(file + ": no results");
    process.exit(2);
  }
  for (const result of results) {
    const id = result.fixture;
    const success = result.score?.success === true;
    const entry = verdicts.get(id) ?? { passes: 0, seen: 0 };
    entry.seen += 1;
    if (success) {
      entry.passes += 1;
    }
    verdicts.set(id, entry);
  }
}

const runs = args.length;
const fixtures = {};
const incomplete = [];
for (const [id, entry] of verdicts) {
  if (entry.seen !== runs) {
    incomplete.push(id + " (" + entry.seen + "/" + runs + ")");
    continue;
  }
  fixtures[id] = entry.passes * 2 > runs ? "pass" : "fail";
}
if (incomplete.length > 0) {
  console.error("these fixtures were not reached by every run: " + incomplete.join(", "));
  process.exit(2);
}

const ids = Object.keys(fixtures);
const passed = ids.filter((id) => fixtures[id] === "pass").length;
const record = {
  model,
  recorded_at: new Date().toISOString().slice(0, 10),
  arm: arm ?? "mcp",
  runs,
  fixtures,
  summary: { cases: ids.length, passed, successRate: ids.length === 0 ? 0 : passed / ids.length },
};

parseBaseline(record, output);
writeFileSync(output, JSON.stringify(record, null, 2) + "\n");
console.log(
  "recorded " + output + ": " + String(passed) + "/" + String(ids.length) + " pass over " + String(runs) + " run(s) of " + String(model) + " (" + String(provider ?? "?") + ")",
);
