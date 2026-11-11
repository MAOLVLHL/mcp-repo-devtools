# Changelog

## 0.4.0 - 2026-11-12

### Added

- Six `github` fixtures, and a fixture kind to hold them: each one is a real repository
  plus a stubbed workflow run — check runs, the run's jobs, and the failing job's log behind
  a redirect — so a regression whose only evidence is a CI log is now scored. The other
  thirty stay `kind: "git"`, where the checkout is the evidence.
- `--kind git|github|all` on the eval CLI, and a per-kind line in the summary, because a
  score over both kinds hides which half of the tool surface earned it.
- No miss is waived, on either arm, and no fixture is exempt. The raw arm is scored on the
  thirty git fixtures (`npm run eval:baseline` passes `--kind git`) because its single tool
  cannot read a CI log; `--arm baseline --kind all` exits 1, truthfully. The measured run
  then showed the six CI fixtures do not separate the arms either: a real model holding
  nothing but git solved all **18/18** of them, at 8,247 tokens per case against the typed
  arm's 14,905. That is published in `docs/eval.md` rather than tuned away.
- `tests/eval-github.test.ts`: the stub answers the three routes `gh_ci_failures` asks for
  (and 404s everything else), the log download redirects to a host that never receives the
  token, the oracle solves a CI fixture on the typed arm, and the scripted raw arm scores
  it as a miss because no scripted trajectory of one `git` call can reach a workflow log.
- The eval now has thirty fixtures, up from ten: twelve Python and eight JavaScript,
  covering money rounded wrong, an off-by-one paginator, a mutable default argument, a
  cache key that lost the tenant, an in-place sort, a race on a cache miss, and twenty-two
  more. Each one ships a runnable test suite that is green at the culprit's parent and red
  at HEAD, so a fixture that grades nothing fails the harness rather than the model.
- `eval/baseline.json` and `src/eval/baseline.ts`: a recorded run as a per-fixture gate.
  `success@1` is a coin flip on one run and an average hides a swap; a fixture the record
  solved may not stop being solved without a person saying so.
- `--check <file>` and `--max-regressions <n>` on the eval CLI, plus `npm run eval:check`.
  The comparison prints the rate now against the rate recorded, the regressions, the
  recoveries, and the fixtures the record does not know — the last two for information,
  the first as the failure.
- `npm run eval:record` (`scripts/record-baseline.mjs`): three runs in, one majority
  verdict per fixture out. It refuses to guess about a fixture some run never reached.
- `tests/eval-baseline.test.ts`: the parse rejects a record that cannot gate, a regression
  fails, a recovery does not, an unmeasured fixture fails until it is recorded, and
  `--max-regressions` tolerates exactly what it is told to.
- `ci.yml` grows an `eval` job: both arms through the scripted oracle (36/36 on the typed
  arm, 30/30 on the raw one over the git kind) and then `eval:check`, so a broken fixture
  or a drifted harness fails a pull request with no model and no secret.
- `.github/workflows/eval-model.yml`: `workflow_dispatch` for the measured half — the same
  `--check` against a real model, failing the workflow on a regression and uploading the
  JSON either way.

### Fixed

- The eval task asked for "the full commit sha" while `git_log` prints `%h`, so the typed
  arm was scored on an identifier its own tools could not produce: a model that found the
  right commit padded the seven characters it had, and every padded answer counted as a
  failure. The prompt now asks for the sha "exactly as the history printed it"; the grader
  still treats a padded sha as a fabrication (`tests/eval-grade.test.ts`), because an
  invented identifier is not a citation. With the fix the typed arm scores 108/108 over three
  runs instead of 87%.

### Changed

- `gh_ci_failures` keeps the lines around the **first error** instead of the last forty.
  The end of a job log is teardown and "process completed with exit code 1" — the part a
  model can already infer — while the assertion that explains the run sits hundreds of
  lines higher. The window keeps five lines of run-up and spends the rest on the trace; a
  log with no marker still degrades to exactly the old tail (`errorWindow` in
  `src/text.ts`, `tests/text.test.ts`).
- The GitHub User-Agent reports the version from `package.json` (`src/version.ts`) instead
  of a literal that had frozen at 0.1.0 in one caller and 0.2.0 in two others.
- The measured eval numbers are re-run on the thirty-six fixtures: **108/108** on both arms,
  4.73 turns and 13,883 tokens per case for the typed arm against 4.31 and **6,540** for one
  raw git tool. The published table is a cost result, not a correctness one, and it says so.
- The byte table is re-measured on a fresh failed run: `gh_ci_failures` returns 12,218 B of
  a 405,577 B log (97.0% saved) instead of a tail of it, because the window now spends its
  lines around the first error. The CI call is slower than the naive download (15.9 s vs
  4.7 s) and still says so in `bench/README.md`.


## 0.3.0 - 2026-11-11

### Added

- All nine tools carry MCP annotations (`readOnlyHint`, `destructiveHint`,
  `idempotentHint`, `openWorldHint`), and the server sends usage instructions at
  initialize, so a host can label and group tools without reading prose.
- The six read tools declare an `outputSchema` and return their data as
  `structuredContent` alongside the text. Structured content passes the same
  credential redactor (recursively) and is dropped on any failure, so a host never
  reads fields from a partial result.
- `git_diff` reports `truncated: true` in its structured copy when the patch was cut.
- `tests/structured-output.test.ts`: field-level assertions for all six read tools,
  including an over-budget patch and a credential inside a commit subject.
- `gh_ci_failures` reports one `notifications/progress` event per GitHub hop when the
  client sends a `progressToken`, so a ten-second call can show which step it is on.
  The first event carries no `total`; the last one equals it.
- Every request now carries the caller's abort signal into `fetch` and `execFile`,
  so cancelling a tool call stops the in-flight work instead of leaving it to time out.
- `tests/request-context.test.ts` and `tests/progress.test.ts`: the context factory,
  the notification sequence, the no-token path and cancellation, over an in-memory
  transport with a stubbed network.
- `src/agent/`: a reference agent loop over this server's read tools, answering one
  question — which commit introduced a CI failure. `provider.ts` defines a one-method
  `Provider` seam with an OpenAI-compatible implementation and a scripted one,
  `loop.ts` runs turns with caps on turns, calls per turn and bytes per result,
  `diagnose.ts` holds the task and its evidence-first prompt, and `cli.ts` runs it from
  the terminal. Read-only by construction: the loop connects with `enableWrite: false`.
- The loop does not treat silence as an answer: a reply with no text and no tool calls is
  answered with one more turn (at most twice) asking for the report, so a model that stops
  mid-thought is nudged instead of scored on an empty string.
- `scripts/demo-agent.mjs` and `npm run demo:agent`: the loop end to end offline — a
  failing CI call, a real `git log`, and the report — with no API key.
- `tests/agent-loop.test.ts`, `tests/agent-provider.test.ts`,
  `tests/agent-mcp.test.ts` and `tests/agent-openai.test.ts`: the loop mechanics, the
  request body and error paths, the tool round trip over an in-memory transport, and one
  run against a real HTTP endpoint that speaks `/chat/completions`.
- [`docs/agent.md`](docs/agent.md): the loop, the provider seam, the caps, how to point
  the CLI at any OpenAI-compatible endpoint, and what the agent deliberately is not.

- `eval/`: a task-level eval — ten offline fixtures, each a repository baked from a few
  commits with one regression, the symptom a user would report, and the sha that
  introduced it. Cases run through the same loop and turn cap against two arms: the six
  read tools, or one raw `git` tool that returns output verbatim.
- Grading is deterministic and trajectory-based: success@1 on the cited commit, turns,
  tool calls, duplicate calls, tokens and read-only violations, with no judge model.
- `eval/cli.ts` (`npm run eval`, `npm run eval:baseline`): the scripted oracle run that
  must stay 10/10, and an `--provider openai` run for real measurements against any
  OpenAI-compatible endpoint. A case that raises is reported as `ERROR` and the suite
  continues; the CLI exits 1 and names the cases that did not finish, so one bad response
  cannot look like a low score.
- [`docs/eval.md`](docs/eval.md): the ten regressions, how both arms are held equal, what
  is and is not scored, and how to add a fixture.
- The first real-model numbers, in [`docs/eval.md`](docs/eval.md) and the README: three
  runs per arm, 30 cases each. The six-tool arm scored 26/30 against the raw-git
  baseline's 30/30, at 1.9× the tokens. Published as measured — a benchmark that can only
  report a win is not one.

- Three MCP prompts — `diagnose-ci`, `review-pr`, `triage-issues` — that a host can offer
  as commands. Each renders an ordered, read-only plan over the existing tools and ends by
  naming what not to do (no edits, no comments, no issues).
- Human confirmation before a write: when the client advertises `elicitation`, the three
  write tools ask who, what and where first, and send nothing when the answer is no. A
  refusal returns the human's note with `isError: true`. `MCP_CONFIRM_WRITES=1` fails
  closed for clients that cannot ask; `=0` never asks.
- Optional sampling compression: `MCP_SAMPLING_COMPRESSION=1` lets a client that
  advertises `sampling` summarise a result that would have been clipped, labelled
  `…compressed from N bytes by the client model`. Timeouts, errors and empty replies fall
  back to the clip; results inside the budget are untouched and never sampled.
- [`docs/tools.md`](docs/tools.md): the write-confirmation matrix, the summary format and
  the three prompt plans. [`docs/architecture.md`](docs/architecture.md): why each of the
  three capabilities can improve a call but never widen what the server may do.

### Changed

- The tool surface grows only additively: names, argument schemas and defaults are
  unchanged, and the rendered text is byte-identical to 0.2.1.
- `docs/tools.md` and `docs/architecture.md` now describe the three layers a result
  can carry, and `scripts/contract-snapshot.mjs` locks annotations and output schemas
  into the checked-in fixture.
- Each per-request timeout (15 s for API calls, 30 s for log downloads) is now combined
  with the caller's signal rather than replaced by it; neither cancels the other.
- `eval/fixtures/float-equality-breaks-total.json`: the cited commit now actually breaks
  the failing test, by dropping the rounding from `total`. It used to change `is_zero`,
  which `test_total` never calls; a real model pointed that out in every run, and was
  right. The oracle could not catch it, because the oracle cites `expected_commit` by
  construction.
- `--help` now describes the surface the same way the package metadata does, and prints the
  whole environment contract rather than the three variables it printed before: the write gate,
  the confirmation mode and the sampling switch are all listed where a person looks first.
- The package now describes itself from the agent's side: the README opens with the
  agent contract (annotations, structured content, progress, cancellation, the write gate,
  the prompts, the loop and the eval) and with the rules an agent should follow when it
  reads the page, and `package.json` carries the description and keywords that say so.
  No behaviour changed with the wording.

## 0.2.1 - 2026-11-11

### Added

- `bench/measure.mjs` and `bench/README.md`: each tool is measured against the naive command it replaces, on reproducible fixtures (and, for the GitHub rows, a live public repository). The README's numbers come from this run.
- `docs/tools.md`: the full argument table, example output and truncation behaviour for all nine tools.
- `docs/security.md`: control-by-control "what it stops / what it does not", plus the four boundary probes the benchmark requires to be refused.
- `tests/contract.test.ts` and `tests/fixtures/tool-surface.json`: the registered tool surface is now a checked-in contract, with `npm run snapshot` to regenerate it deliberately.
- `CONTRIBUTING.md`, `SECURITY.md`, issue forms and a pull-request template.

### Changed

- The README now states the measurement, its caveats, and what the server is *not*.
- No runtime behaviour changed and no tool signature moved: the surface snapshot is the six 0.1.0 tools.

## 0.2.0 - 2026-11-11

### Added

- `gh_ci_failures` takes `include_logs` and `log_lines` and returns the tail of the failing job's log, unpacked in process from the Actions archive by `src/zip.ts`. The archive is fetched by following GitHub's redirect without the token.
- Opt-in write tools, registered only when `MCP_ENABLE_WRITE=1`: `gh_pr_create`, `gh_issue_create` and `gh_pr_comment`. Every write appends a line to stderr.
- `docs/architecture.md`: trust boundaries, request lifecycle, deliberate limits.
- npm packaging: `repository`/`homepage`/`bugs`, `publishConfig`, a `prepublishOnly` build-and-test gate, and a `Publish` workflow that uses `NPM_TOKEN` with provenance.

### Changed

- Nothing in the read-only surface changed: the default tool list is still the six tools from 0.1.0.
## 0.1.0 - 2026-11-11

First release.

### Added

- `git_status`, `git_log` and `git_diff` tools over a subcommand-allowlisted, read-only git runner.
- `gh_issue_search`, `gh_ci_failures` and `gh_pr_context` tools for the GitHub REST API.
- Required `MCP_ALLOWED_ROOTS` containment with `realpath` resolution and a refusal to use a filesystem root.
- Output budget of 200 lines / 64 KB with an actionable truncation note.
- Credential redaction for `ghp_`, `gho_`, `ghs_`, `ghu_`, `github_pat_`, `Bearer` and `x-access-token` values.