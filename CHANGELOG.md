# Changelog

## 0.1.0 - 2026-11-11

First release.

### Added

- `git_status`, `git_log` and `git_diff` tools over a subcommand-allowlisted, read-only git runner.
- `gh_issue_search`, `gh_ci_failures` and `gh_pr_context` tools for the GitHub REST API.
- Required `MCP_ALLOWED_ROOTS` containment with `realpath` resolution and a refusal to use a filesystem root.
- Output budget of 200 lines / 64 KB with an actionable truncation note.
- Credential redaction for `ghp_`, `gho_`, `ghs_`, `ghu_`, `github_pat_`, `Bearer` and `x-access-token` values.
