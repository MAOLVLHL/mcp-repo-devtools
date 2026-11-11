/**
 * The eval CLI.
 *
 *   node dist/eval/cli.js                        # scripted oracle, all fixtures, offline
 *   node dist/eval/cli.js --arm baseline         # the same cases with one raw git tool
 *   OPENAI_API_KEY=… node dist/eval/cli.js --provider openai
 *   node dist/eval/cli.js --check eval/baseline.json   # gate this run per fixture
 *
 * The oracle run is the one CI uses: it must be 30/30, because a harness that
 * cannot score a known-correct trajectory cannot be trusted with a model's.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { ScriptedProvider, providerFromEnv, type Provider } from "../agent/provider.js";
import { compareToBaseline, formatComparison, parseBaseline, type BaselineComparison } from "./baseline.js";
import { loadFixtures } from "./fixture.js";
import { oracleTurns } from "./oracle.js";
import { runCase, type Arm, type CaseResult } from "./run.js";
import { formatSummary, formatTable, summarize } from "./suite.js";

const HELP = [
  "Usage: eval [options]",
  "",
  "  --fixtures <dir>   fixture directory (default eval/fixtures)",
  "  --arm <name>       mcp (default) or baseline (one raw git tool)",
  "  --provider <name>  scripted (default) or openai",
  "  --max-turns <n>    turn cap per case (default 8)",
  "  --check <file>     compare the run against a recorded baseline (eval/baseline.json)",
  "  --max-regressions  regressions tolerated by --check (default 0)",
  "  --json             print the results as JSON",
  "  -h, --help         show this message",
].join("\n");

/** A case that raised instead of returning a score: a dead endpoint, a bad key, a 502. */
interface CaseFailure {
  fixture: string;
  message: string;
}

interface CliValues {
  fixtures?: string;
  arm?: string;
  provider?: string;
  "max-turns"?: string;
  check?: string;
  "max-regressions"?: string;
  json?: boolean;
  help?: boolean;
}

function caseLine(result: CaseResult): string {
  const score = result.score;
  const citation = score.cited === null ? "no sha" : score.cited.slice(0, 9);
  return [
    score.success ? "pass" : "FAIL",
    result.fixture.id.padEnd(36),
    citation.padEnd(10),
    String(score.turns) + " turns",
    String(score.toolCalls) + " calls",
    String(score.tokens.input + score.tokens.output) + " tokens",
  ].join("  ");
}

export async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      fixtures: { type: "string", default: "eval/fixtures" },
      arm: { type: "string", default: "mcp" },
      provider: { type: "string", default: "scripted" },
      "max-turns": { type: "string", default: "8" },
      check: { type: "string" },
      "max-regressions": { type: "string", default: "0" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });
  const cli = values as CliValues;

  if (cli.help === true) {
    console.log(HELP);
    return 0;
  }

  const arm: Arm = cli.arm === "baseline" ? "baseline" : "mcp";
  if (cli.arm !== "mcp" && cli.arm !== "baseline") {
    console.error("unknown arm: " + String(cli.arm) + " (expected mcp or baseline)");
    return 2;
  }
  const providerKind = cli.provider ?? "scripted";
  if (providerKind !== "scripted" && providerKind !== "openai") {
    console.error("unknown provider: " + providerKind + " (expected scripted or openai)");
    return 2;
  }

  const fixtures = loadFixtures(path.resolve(cli.fixtures ?? "eval/fixtures"));
  const maxTurns = Number(cli["max-turns"] ?? "8");
  if (!Number.isInteger(maxTurns) || maxTurns < 1) {
    console.error("--max-turns must be a positive integer");
    return 2;
  }
  const allowedRegressions = Number(cli["max-regressions"] ?? "0");
  if (!Number.isInteger(allowedRegressions) || allowedRegressions < 0) {
    console.error("--max-regressions must be a non-negative integer");
    return 2;
  }

  let shared: Provider | null = null;
  if (providerKind === "openai") {
    try {
      shared = providerFromEnv();
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 2;
    }
  }

  const root = mkdtempSync(path.join(tmpdir(), "repo-devtools-eval-"));
  const results: CaseResult[] = [];
  const failures: CaseFailure[] = [];
  try {
    for (const fixture of fixtures) {
      try {
        const result = await runCase(fixture, root, {
          arm,
          limits: { maxTurns },
          providerFor: (build) => shared ?? new ScriptedProvider(oracleTurns(fixture, build, arm)),
        });
        results.push(result);
        if (cli.json !== true) {
          console.log(caseLine(result));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ fixture: fixture.id, message });
        if (cli.json !== true) {
          console.log(["ERROR", fixture.id.padEnd(36), message.slice(0, 200)].join("  "));
        }
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const summary = summarize(results);

  let check: BaselineComparison | undefined;
  let checkText = "";
  if (cli.check !== undefined) {
    try {
      const record = parseBaseline(JSON.parse(readFileSync(cli.check, "utf8")), cli.check);
      check = compareToBaseline(record, results, { maxRegressions: allowedRegressions });
      checkText = formatComparison(record, check);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 2;
    }
  }

  if (cli.json === true) {
    console.log(
      JSON.stringify(
        {
          arm,
          provider: providerKind,
          summary,
          failures,
          ...(check === undefined ? {} : { check }),
          results: results.map((result) => ({
            fixture: result.fixture.id,
            expected: result.build.expectedSha,
            score: result.score,
          })),
        },
        null,
        2,
      ),
    );
  } else {
    console.log("");
    console.log(formatTable(results));
    console.log("");
    console.log(formatSummary(summary));
    if (failures.length > 0) {
      console.log("");
      console.log(String(failures.length) + " case(s) did not finish:");
      for (const failure of failures) {
        console.log("  " + failure.fixture + " — " + failure.message.slice(0, 200));
      }
    }
    if (check !== undefined) {
      console.log("");
      console.log(checkText);
    }
  }

  if (failures.length > 0) {
    return 1;
  }
  if (check !== undefined && !check.ok) {
    return 1;
  }
  if (providerKind === "scripted" && summary.passed !== summary.cases) {
    return 1;
  }
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}