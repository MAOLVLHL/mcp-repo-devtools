# mcp-repo-devtools

`Read-only` MCP server for the three things you look up before touching a repository: **git history, GitHub issues, and CI failures**.

An agent that can read a whole log file will read a whole log file. This server gives it six narrow tools instead, each with a hard output budget and a hard boundary on what it may touch.

```text
git_status        branch, upstream, ahead/behind, changed paths
git_log           newest commits, optionally scoped to a path
git_diff          --stat by default, unified patch on request
gh_issue_search   issues in one repo, newest activity first
gh_ci_failures    only the failing checks, with failed step names
gh_pr_context     title, body, files, reviews and review comments
```

Nothing here writes. There is no `git push`, no shell, no arbitrary URL fetch.

## Why a separate server

- **Read-only by construction.** Subcommands come from an allowlist; there is no code path that can run `push`, `config` or an arbitrary shell.
- **Bounded output.** Every result is cut to 200 lines / 64 KB and ends with a hint that tells the model how to narrow the next call.
- **No credential leaks.** Every string returned to the model passes through a redactor for `ghp_` / `github_pat_` / `Bearer` tokens before it leaves the process.
- **Roots, not vibes.** `MCP_ALLOWED_ROOTS` is required; paths are resolved with `realpath` before the comparison, so a symlink cannot walk out of the allowed tree.

## Install

From source (works today):

```bash
git clone https://github.com/MAOLVLHL/mcp-repo-devtools
cd mcp-repo-devtools
npm install
npm run build
```

From npm (after the first publish):

```bash
npx -y mcp-repo-devtools --help
```

Either way the server speaks MCP over stdio and needs two environment variables:

| Variable | Required | Meaning |
| --- | --- | --- |
| `MCP_ALLOWED_ROOTS` | yes | Directories the server may read, separated by the platform path separator (`:` on Unix, `;` on Windows). Filesystem roots are refused. |
| `GITHUB_TOKEN` | no | Raises the GitHub API limit from 60 to 5000 requests/hour. Only `repo` read access is needed. |

## Configure a client

Claude Code:

```bash
claude mcp add repo-devtools -s project \
  -e MCP_ALLOWED_ROOTS=/home/you/code \
  -e GITHUB_TOKEN=$GITHUB_TOKEN \
  -- node /absolute/path/to/mcp-repo-devtools/dist/index.js
claude mcp list
```

Cursor (`.cursor/mcp.json` in the project, or the same shape in `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "repo-devtools": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-repo-devtools/dist/index.js"],
      "env": {
        "MCP_ALLOWED_ROOTS": "/home/you/code",
        "GITHUB_TOKEN": "${env:GITHUB_TOKEN}"
      }
    }
  }
}
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.repo-devtools]
command = "node"
args = ["/absolute/path/to/mcp-repo-devtools/dist/index.js"]
env = { MCP_ALLOWED_ROOTS = "/home/you/code" }
```

Restart the client, then ask it to "check the git status of this repo". Tool names appear exactly as listed above.

## Tools

### `git_status`

| Argument | Type | Default | Notes |
| --- | --- | --- | --- |
| `repo` | string | required | Absolute path, inside `MCP_ALLOWED_ROOTS` |

Returns the branch, upstream, ahead/behind counts and up to 200 changed paths with a status word (`modified`, `untracked`, `renamed`, …).

### `git_log`

| Argument | Type | Default | Notes |
| --- | --- | --- | --- |
| `repo` | string | required | Absolute path |
| `path` | string | – | Scope history to a file or directory |
| `limit` | int 1–100 | `20` | Number of commits |

### `git_diff`

| Argument | Type | Default | Notes |
| --- | --- | --- | --- |
| `repo` | string | required | Absolute path |
| `base` | string | `HEAD` | Ref, tag or sha; must not start with `-` |
| `path` | string | – | Scope the diff |
| `mode` | `stat` \| `patch` | `stat` | `patch` returns a unified diff |
| `context_lines` | int 0–50 | `3` | Hunk context in patch mode |

### `gh_issue_search`

| Argument | Type | Default | Notes |
| --- | --- | --- | --- |
| `repo` | string | required | `owner/name` |
| `query` | string | `""` | Search terms, e.g. `label:bug timeout` |
| `state` | `open` \| `closed` \| `all` | `open` | |
| `limit` | int 1–30 | `10` | |

Search results only contain issues: pull requests are filtered out even if GitHub returns them.

### `gh_ci_failures`

| Argument | Type | Default | Notes |
| --- | --- | --- | --- |
| `repo` | string | required | `owner/name` |
| `ref` | string | required | Sha, branch, tag or PR head ref |

Reads check runs, keeps the failing ones, then looks up the workflow job to name the failed steps. It never downloads a full log.

### `gh_pr_context`

| Argument | Type | Default | Notes |
| --- | --- | --- | --- |
| `repo` | string | required | `owner/name` |
| `number` | int | required | Pull request number |

One call returns the title, body excerpt, base/head, size, up to 100 changed files (30 printed), review states and review comments.

## Output contract

Every tool result is plain text, capped at **200 lines / 64 KB**, and ends with a note when something was cut:

```text
…truncated (431 more lines; narrow with path= or max_lines=)
```

Errors come back as `isError: true` with a message that says what to do next, for example:

```text
Error: repository C:\tmp\x is outside MCP_ALLOWED_ROOTS (C:\code)
Error: GitHub rate limit exhausted; resets at 2026-11-11T20:00:00.000Z. Set GITHUB_TOKEN to get 5000 requests/hour.
```

## Security model

| Control | Implementation |
| --- | --- |
| No shell | `child_process.execFile` with an argv array; nothing is interpolated into a command line |
| No write commands | `ALLOWED_SUBCOMMANDS` in `src/git.ts` |
| No config injection | `FORBIDDEN_FLAGS` rejects `-c`, `--exec-path`, `--upload-pack`, `--git-dir`, `--output`, … |
| No path escape | `assertAllowedRepo` resolves with `realpath` and compares against `MCP_ALLOWED_ROOTS` |
| No inherited git state | the child environment only carries `PATH`, `HOME`, `USERPROFILE`, `SystemRoot`, `TMP`, `TEMP`, `LANG` |
| No secrets in output | `redact()` runs on every git stderr and every GitHub response |
| No hanging | 10 s timeout per git call, 15 s per GitHub call |

What this is **not**: a sandbox. It reads the repositories you point it at, with your user's permissions.

## Development

```bash
npm install
npm run build        # tsc -> dist/
npm test             # build + node:test (36 tests)
npm run inspect      # MCP Inspector against the built server
```

A manual smoke test against a real checkout:

```bash
node scripts/smoke.mjs /path/to/repo owner/name
```

Layout:

```text
src/config.ts   MCP_ALLOWED_ROOTS parsing and realpath containment
src/git.ts      execFile wrapper, allowlists, status/log/diff
src/github.ts   REST calls for issues, checks and pull requests
src/text.ts     output budget and credential redaction
src/server.ts   tool registration and text formatting
src/index.ts    stdio entry point
```

## Roadmap

- `gh_ci_failures`: optionally fetch the failing job's log and extract only the error block
- `gh_issue_search`: cache ETags between calls
- `git_blame` / `git_show`: already allowed at the transport layer, not exposed yet
- HTTP transport for hosted use (out of scope for v0.1: stdio keeps the trust boundary simple)

## License

MIT
