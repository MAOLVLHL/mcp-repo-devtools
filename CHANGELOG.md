# Changelog

## Unreleased

### Added

- All nine tools carry MCP annotations (`readOnlyHint`, `destructiveHint`,
  `idempotentHint`, `openWorldHint`), and the server sends usage instructions at
  initialize, so a host can label or group tools without reading prose.
- `tests/contract.test.ts` now pins the four hints per tool, and
  `scripts/contract-snapshot.mjs` records them in the checked-in surface fixture.

### Changed

- Nothing about calling a tool changed: names, argument schemas, defaults and the
  rendered text are identical to 0.2.1. The surface only grows.

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