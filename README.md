# mcp-repo-devtools

[![CI](https://github.com/MAOLVLHL/mcp-repo-devtools/actions/workflows/ci.yml/badge.svg)](https://github.com/MAOLVLHL/mcp-repo-devtools/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/mcp-repo-devtools?label=npm)](https://www.npmjs.com/package/mcp-repo-devtools)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![node >= 20.11](https://img.shields.io/badge/node-%E2%89%A520.11-informational)

**An agent that can read a whole log file will read a whole log file.**

`mcp-repo-devtools` is an MCP server for the four things an agent looks up *before* it
touches a repository — working tree, history, issues, CI failures — plus pull-request
context and three opt-in write tools. Every result has a hard budget, every query has a
hard boundary, and both are measured rather than asserted.

- **Bounded, and measured.** On a real failed CI run, reading the logs it needed cost
  **322,887 bytes raw; the tool returned 13,915** (95.7% less). Issue search over a
  busy repository: **176,170 → 4,371** (97.5%). Twenty commits with `git log -p`:
  **19,300 → 992** (94.9%). The numbers, the fixtures and the caveats are in
  [`bench/README.md`](bench/README.md); the script that produced them is
  [`bench/measure.mjs`](bench/measure.mjs).
- **Read-only by construction.** Thirteen git subcommands, an argv array, no shell
  anywhere. The three write tools exist only when `MCP_ENABLE_WRITE=1`, and each one
  logs a line to stderr before the request goes out.
- **Rooted, not vibes.** `MCP_ALLOWED_ROOTS` is required; paths are `realpath`-resolved
  before the containment check, filesystem roots are refused, and model-supplied refs
  cannot start with `-`.
- **Small surface, honest failures.** Six tools by default. Errors say what to do next
  (`Error: GitHub rate limit exhausted; resets at … Set GITHUB_TOKEN …`), and truncation
  is never silent — the last line names the argument that narrows the next call.

## Quickstart

The package is not on npm yet, so the release tarball is the installable artifact today:

```bash
npm install -g https://github.com/MAOLVLHL/mcp-repo-devtools/releases/download/v0.2.1/mcp-repo-devtools-0.2.1.tgz
mcp-repo-devtools --version        # 0.2.1
mcp-repo-devtools --help           # prints the env contract and exits
```

Until the publish lands, use the global binary `mcp-repo-devtools` wherever a client
config below says `npx -y mcp-repo-devtools`. Once it is on npm, `npx` is the
zero-install path and nothing else changes.

The server speaks MCP over stdio. Two variables matter:

| Variable | Required | Meaning |
| --- | --- | --- |
| `MCP_ALLOWED_ROOTS` | yes | Directories the server may read, separated by the platform separator (`:` on Unix, `;` on Windows). A filesystem root is refused. |
| `GITHUB_TOKEN` | no | Raises the GitHub limit from 60 to 5000 requests/hour and is required for log tails and for writes. Fine-grained, read-only is enough for the read tools. |
| `MCP_ENABLE_WRITE` | no | `1` adds `gh_pr_create`, `gh_issue_create`, `gh_pr_comment`. Anything else keeps the server read-only. |

## Configure a client

**Claude Code**

```bash
claude mcp add repo-devtools -s project \
  -e MCP_ALLOWED_ROOTS=/home/you/code \
  -e GITHUB_TOKEN=$GITHUB_TOKEN \
  -- npx -y mcp-repo-devtools
claude mcp list        # repo-devtools: … ✓ Connected
```

**Cursor** — `.cursor/mcp.json` in the project, or the same shape in `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "repo-devtools": {
      "command": "npx",
      "args": ["-y", "mcp-repo-devtools"],
      "env": {
        "MCP_ALLOWED_ROOTS": "/home/you/code",
        "GITHUB_TOKEN": "${env:GITHUB_TOKEN}"
      }
    }
  }
}
```

**Codex** — `~/.codex/config.toml`:

```toml
[mcp_servers.repo-devtools]
command = "npx"
args = ["-y", "mcp-repo-devtools"]
env = { MCP_ALLOWED_ROOTS = "/home/you/code", GITHUB_TOKEN = "ghp_…" }
```

Restart the host, then ask it to "check the git status of this repo". Tool names appear
exactly as listed below. From a checkout instead of npm: `npm install && npm run build`
and point the client at `/absolute/path/to/mcp-repo-devtools/dist/index.js`.

## The tools

| Tool | One call returns | Notes |
| --- | --- | --- |
| `git_status` | branch, upstream, ahead/behind, up to 200 changed paths | Start here; it tells you what to diff |
| `git_log` | the newest commits, one line each, optionally scoped to a path | No patches — that is the point |
| `git_diff` | `--stat` by default, unified patch on request | `base` accepts a rev, tag or sha |
| `gh_issue_search` | issues in one repo, newest activity first, body excerpt | Pull requests are filtered out |
| `gh_ci_failures` | only failing checks, failed step names, optional log tail | `include_logs: true` for the last 40 lines |
| `gh_pr_context` | title, body, size, files, review states, review comments | Replaces four REST calls |
| `gh_pr_create` | opens a PR from a branch already pushed | write mode only |
| `gh_issue_create` | files an issue | write mode only |
| `gh_pr_comment` | comments on an issue or PR | write mode only |

Full argument tables, example output and the exact truncation notes:
[`docs/tools.md`](docs/tools.md).

## Measured, not estimated

The baseline in every row is the *good* version of what an agent does without this
server: the same command, the same endpoint, no truncation. Measured 2026-11-11 on
Windows 11, Node 22.14, git 2.56; tokens are bytes / 4.

| Case | Naive | Tool | Saved |
| --- | ---: | ---: | ---: |
| `gh_ci_failures` — 3 failed jobs, real run | 322,887 B | 13,915 B | **95.7%** |
| `gh_issue_search` — 30 raw results vs 10 formatted | 176,170 B | 4,371 B | **97.5%** |
| `git_log` — 20 commits, `git log -p` | 19,300 B | 992 B | **94.9%** |
| `git_diff` — 400 dirty files, patch vs stat | 75,960 B | 5,236 B | **93.1%** |
| `git_diff` — HEAD~5, patch vs stat | 3,641 B | 290 B | **92.0%** |
| `git_status` — 400 dirty files, capped at 200 | 8,320 B | 5,621 B | **32.4%** |

Caveats, stated rather than buried: n = 1 per cell; the git rows use generated fixtures
so they reproduce anywhere, the GitHub rows hit a live public repository; and
`gh_ci_failures` is *slower* than the naive path (10.4 s vs 5.1 s) because it resolves
ref → commit → checks → jobs → logs before it decides what to download. Bytes and
latency trade against each other, and the table only measures one side. Full method:
[`bench/README.md`](bench/README.md).

## Safety model

| Control | Implementation |
| --- | --- |
| No shell | `execFile("git", argv)`; nothing is interpolated into a command line |
| No write commands | `ALLOWED_SUBCOMMANDS` (13 entries) in `src/git.ts` |
| No config injection | `FORBIDDEN_FLAGS`: `-c`, `-C`, `--exec-path`, `--upload-pack`, `--git-dir`, `--work-tree`, `--config-env`, `--output`, … |
| No path escape | `realpath` + `path.relative` containment against `MCP_ALLOWED_ROOTS` |
| No inherited git state | child env limited to `PATH`, `HOME`, `USERPROFILE`, `SystemRoot`, `TMP`, `TEMP`, `LANG`, `LC_ALL` |
| No secrets in output | every git stderr and GitHub response passes `redact()` |
| No token to the blob host | job-log redirects are followed by hand, without `Authorization` |
| No hanging | 10 s git, 15 s GitHub, 30 s log download |

Every benchmark run also fires four boundary probes (path escape, `--output`,
shell metacharacters in a ref, a malformed `owner/name`) and requires all four to be
refused — see [`bench/README.md`](bench/README.md#boundary-probes). The full threat
model, including what these controls do **not** cover, is in
[`docs/security.md`](docs/security.md).

## What this is not

- **Not a sandbox.** It reads the roots you configure, with your permissions. Point it
  at a code directory, not at your home directory.
- **Not an agent.** It has no loop, no planning, no memory between calls.
- **Not a GitHub client.** No push, merge, close, branch creation, or file editing.
  Those belong to the agent's own git client, where the human already watches.
- **Not an injection filter.** Commit messages, issue bodies and log lines are returned
  as data; a string that says "ignore previous instructions" is still a string.
- **Not an HTTP service.** stdio only. A hosted mode needs an auth design before it can
  be safe, and that design is not in this repository.

## Development

```bash
npm install
npm run build        # tsc -> dist/
npm test             # build + node:test, 53 tests
npm run snapshot     # rewrite tests/fixtures/tool-surface.json after a surface change
npm run bench        # the measurement above (needs a checkout, and a token for GitHub rows)
npm run inspect      # MCP Inspector against the built server
```

The tool surface is a contract: `tests/contract.test.ts` fails if a tool appears,
disappears, or changes its arguments without the snapshot being updated on purpose.

```text
src/config.ts   MCP_ALLOWED_ROOTS parsing and realpath containment
src/git.ts      execFile wrapper, allowlists, status/log/diff
src/github.ts   REST reads, CI log download, opt-in writes
src/zip.ts      minimal zip reader for Actions log archives
src/text.ts     output budget, log tail, credential redaction
src/server.ts   tool registration and text formatting
src/index.ts    stdio entry point
```

Docs: [architecture](docs/architecture.md) · [tool reference](docs/tools.md) ·
[security model](docs/security.md) · [measurements](bench/README.md).

## Roadmap

- `gh_ci_failures`: cut around the first error marker instead of keeping a fixed tail
- `gh_issue_search`: ETag caching between calls
- `git_blame` / `git_show`: already allowed at the transport layer, not exposed yet
- HTTP transport: out of scope until there is an auth design worth shipping

## Contributing

Issues and pull requests are welcome. Please run `npm test` before opening a PR, and if
you change the tool surface, include the `tests/fixtures/tool-surface.json` diff —
that diff is the review record. Security reports: see
[`SECURITY.md`](SECURITY.md).

## License

MIT