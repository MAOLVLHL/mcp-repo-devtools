# Changelog

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