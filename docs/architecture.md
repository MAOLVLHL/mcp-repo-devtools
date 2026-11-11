# Architecture

`mcp-repo-devtools` is a single stdio process that a coding agent starts. It
holds no state between calls, makes no network requests except to GitHub, and
never writes to a repository.

```mermaid
flowchart LR
  subgraph Host["Agent host (Claude Code / Cursor / Codex)"]
    LLM["Model"] --> Client["MCP client"]
  end

  Client -->|"JSON-RPC over stdio"| Server

  subgraph Server["mcp-repo-devtools process"]
    direction TB
    Tools["Tool registry<br/>6 read-only + 3 opt-in writes"]
    Guard["guarded()<br/>redact + clip"]
    Tools --> Guard
    Guard --> GitMod["git.ts<br/>allowlist + argv"]
    Guard --> GhMod["github.ts<br/>REST reads"]
    Guard --> WriteMod["github.ts<br/>POST (write mode only)"]
    GhMod --> Zip["zip.ts<br/>job log archive"]
  end

  GitMod -->|"execFile, no shell"| Repo[("Local git work tree")]
  GhMod -->|"HTTPS"| API[("api.github.com")]
  Zip -->|"HTTPS, redirect followed by hand"| Blob[("Signed blob URL")]
```

## Trust boundaries

| Boundary | Rule | Where |
| --- | --- | --- |
| Process → repository | Only 13 git subcommands; flag denylist stops `-c`, `--exec-path`, `--git-dir`; `execFile` with an argv array, never a shell string | `src/git.ts` |
| Repository path → filesystem | `realpath` the target and require `path.relative(root, target)` to stay inside `MCP_ALLOWED_ROOTS`; a filesystem root is refused as a root | `src/config.ts` |
| Process → GitHub | One base URL, one token, 15 s timeout; redirects are followed manually so the token never reaches the blob host | `src/github.ts` |
| Result → model | Every result passes `redact()` then `clip()` (64 KB / 200 lines) before it leaves the process | `src/server.ts` |
| Write tools | Registered only when `MCP_ENABLE_WRITE=1`, and each call logs a line to stderr | `src/server.ts` |
| Logs | stdout carries protocol frames only; every diagnostic goes to stderr | `src/index.ts` |

## Request lifecycle

1. The host calls a tool. The SDK validates the arguments against the zod schema
   before any of our code runs, so handlers can assume the shape.
2. Path-shaped arguments (`repo`) go through `assertAllowedRepo`; ref-shaped
   arguments (`ref`, `head`, `base`) go through `assertSafeRef`.
3. The handler does one unit of work: one git invocation, or one to four GitHub
   requests. Nothing is cached, so a second call always observes current state.
4. The result is rendered as text, redacted, and clipped. Truncation is not
   silent: the tail line names the parameter that narrows the query.
5. Errors become `isError: true` results with a message that says what to do
   next ("set GITHUB_TOKEN", "narrow with path="), not a stack trace.

## Deliberate limits

- **No shell.** There is no tool that runs an arbitrary command, so prompt
  injection in a repository file cannot escalate to code execution.
- **No writes by default.** Six read tools are always registered; the three
  write tools are an explicit opt-in, because a read-only server is what makes
  this safe to point at any checkout.
- **No caching.** A stale answer about `git status` is worse than a slow one.
- **Log tails only.** `gh_ci_failures` returns the last N lines of a failing
  job, never the whole archive: a full Actions log is megabytes and would blow
  the model's context.

## Adding a tool

1. Add the logic to `src/git.ts` or `src/github.ts` as a plain async function
   that takes validated arguments and returns a typed result.
2. If it returns bytes, decode them in a helper like `src/zip.ts` rather than
   inline in the handler.
3. Register it in `src/server.ts` with a description that says what it answers,
   not what it calls. Write tools belong inside the `if (writeEnabled)` block.
4. Add a test that stubs `fetch` (GitHub) or builds a temporary repository
   (git), plus one end-to-end case in `tests/server.test.ts` only if the wiring
   could plausibly break.
