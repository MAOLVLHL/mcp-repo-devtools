# Changelog

## Unreleased

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

### Changed

- The tool surface grows only additively: names, argument schemas and defaults are
  unchanged, and the rendered text is byte-identical to 0.2.1.
- `docs/tools.md` and `docs/architecture.md` now describe the three layers a result
  can carry, and `scripts/contract-snapshot.mjs` locks annotations and output schemas
  into the checked-in fixture.
- Each per-request timeout (15 s for API calls, 30 s for log downloads) is now combined
  with the caller's signal rather than replaced by it; neither cancels the other.

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