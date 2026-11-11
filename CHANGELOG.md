# Changelog

## Unreleased

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