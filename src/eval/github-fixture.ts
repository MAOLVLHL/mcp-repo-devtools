/**
 * GitHub-shaped fixtures: a workflow run, its failing jobs and the log tail, served
 * to the server by a stub of the three REST endpoints `gh_ci_failures` calls.
 *
 * The point of a separate kind is honesty in the comparison. Every `git` fixture can
 * be answered by `git log -p`, so the raw arm is a fair baseline there. A CI log
 * cannot: it is GitHub state, and a tool surface that cannot read it can only guess.
 * These fixtures measure what the GitHub tools are for.
 */

const API_BASE = "https://api.github.com";
const LOG_HOST = "https://logs.invalid/";
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_PATTERN = /^[0-9a-f]{7,40}$/;

export interface GithubJobStep {
  name: string;
  conclusion: string;
}

export interface GithubJob {
  id: number;
  name: string;
  conclusion: string;
  steps: GithubJobStep[];
}

export interface GithubScenario {
  /** Repository as owner/name, exactly as the model must pass it. */
  repo: string;
  /** Branch, tag or sha the checks ran for. */
  ref: string;
  /** Workflow run id, the number in a github.com/.../actions/runs/<id> URL. */
  run: number;
  jobs: GithubJob[];
  /** The failing job's log, as GitHub would serve it: runner lines, traceback included. */
  log: string;
  /** Head sha reported by the check-runs endpoint. */
  sha: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Fill the parts of a check run the server reads, so a fixture stays short. */
function parseJob(value: unknown, index: number, source: string): GithubJob {
  const record = asRecord(value);
  if (record === null) {
    throw new Error(source + ": github.jobs[" + String(index) + "] must be an object");
  }
  const id = record["id"];
  const name = record["name"];
  const conclusion = record["conclusion"];
  const steps = record["steps"];
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
    throw new Error(source + ": github.jobs[" + String(index) + "].id must be a positive integer");
  }
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new Error(source + ": github.jobs[" + String(index) + "].name must be a non-empty string");
  }
  if (typeof conclusion !== "string" || conclusion.trim().length === 0) {
    throw new Error(source + ": github.jobs[" + String(index) + "].conclusion must be a non-empty string");
  }
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error(source + ": github.jobs[" + String(index) + "].steps must be a non-empty array");
  }
  const parsedSteps = steps.map((step: unknown, stepIndex: number) => {
    const entry = asRecord(step);
    const stepName = entry?.["name"];
    const stepConclusion = entry?.["conclusion"];
    if (typeof stepName !== "string" || stepName.trim().length === 0) {
      throw new Error(
        source + ": github.jobs[" + String(index) + "].steps[" + String(stepIndex) + "].name must be a string",
      );
    }
    return { name: stepName, conclusion: typeof stepConclusion === "string" ? stepConclusion : "success" };
  });
  return { id, name, conclusion, steps: parsedSteps };
}

export function parseGithubScenario(value: unknown, source: string): GithubScenario {
  const record = asRecord(value);
  if (record === null) {
    throw new Error(source + ": github must be an object");
  }
  const repo = record["repo"];
  const ref = record["ref"];
  const run = record["run"];
  const jobs = record["jobs"];
  const log = record["log"];
  const sha = record["sha"];
  if (typeof repo !== "string" || !REPO_PATTERN.test(repo)) {
    throw new Error(source + ": github.repo must look like owner/name");
  }
  if (typeof ref !== "string" || ref.trim().length === 0) {
    throw new Error(source + ": github.ref must be a non-empty string");
  }
  if (typeof run !== "number" || !Number.isInteger(run) || run <= 0) {
    throw new Error(source + ": github.run must be a positive integer");
  }
  if (!Array.isArray(jobs) || jobs.length === 0) {
    throw new Error(source + ": github.jobs must be a non-empty array");
  }
  if (typeof log !== "string" || log.trim().length === 0) {
    throw new Error(source + ": github.log must be the failing job's log");
  }
  if (typeof sha !== "string" || !SHA_PATTERN.test(sha)) {
    throw new Error(source + ": github.sha must be a commit sha (7-40 lowercase hex characters)");
  }
  return {
    repo,
    ref,
    run,
    jobs: jobs.map((job: unknown, index: number) => parseJob(job, index, source)),
    log,
    sha,
  };
}

export interface GithubStub {
  /** Every URL the server asked for, in order, so a test can assert the shape. */
  calls: string[];
  restore(): void;
}

function jsonBody(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function firstFailingJobId(scenario: GithubScenario): number | null {
  for (const job of scenario.jobs) {
    if (job.steps.some((step) => step.conclusion === "failure" || step.conclusion === "timed_out")) {
      return job.id;
    }
  }
  return null;
}

/**
 * Replace `fetch` for the duration of a case. Three routes, because that is exactly
 * what `ciFailures` asks for: check runs, the jobs of one run, and one log download
 * that redirects to a host which must not receive the token.
 */
export function installGithubStub(scenario: GithubScenario): GithubStub {
  const original = globalThis.fetch;
  const calls: string[] = [];
  const failingJob = firstFailingJobId(scenario);
  const checkRuns = {
    total_count: scenario.jobs.length,
    check_runs: scenario.jobs.map((job) => ({
      name: job.name,
      status: "completed",
      conclusion: job.conclusion,
      details_url: "https://github.com/" + scenario.repo + "/actions/runs/" + String(scenario.run) + "/job/" + String(job.id),
      head_sha: scenario.sha,
      output: { title: job.name, summary: job.conclusion },
    })),
  };

  const stub = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    void init;
    if (url === API_BASE + "/repos/" + scenario.repo + "/commits/" + encodeURIComponent(scenario.ref) + "/check-runs?per_page=100&filter=latest") {
      return jsonBody(checkRuns);
    }
    if (url.startsWith(API_BASE + "/repos/" + scenario.repo + "/actions/runs/" + String(scenario.run) + "/jobs")) {
      return jsonBody({ jobs: scenario.jobs });
    }
    const logs = /\/actions\/jobs\/(\d+)\/logs$/.exec(url);
    if (logs && url.startsWith(API_BASE + "/repos/" + scenario.repo)) {
      return new Response(null, { status: 302, headers: { location: LOG_HOST + String(logs[1]) + ".log" } });
    }
    const download = /^https:\/\/logs\.invalid\/(\d+)\.log$/.exec(url);
    if (download) {
      const body = String(download[1]) === String(failingJob) ? scenario.log : "";
      return new Response(body, { status: 200, headers: { "content-type": "text/plain" } });
    }
    return new Response("the fixture has no route for " + url, { status: 404 });
  };

  globalThis.fetch = stub as unknown as typeof fetch;
  let restored = false;
  return {
    calls,
    restore(): void {
      if (restored) {
        return;
      }
      restored = true;
      globalThis.fetch = original;
    },
  };
}

/** The marker a graded report is expected to have read out of the log. */
export function logMarker(scenario: GithubScenario): string {
  const failed = /^\s*(?:.*?)(AssertionError|Error|error):[^\n]*/m.exec(scenario.log);
  return failed?.[0]?.trim() ?? "";
}