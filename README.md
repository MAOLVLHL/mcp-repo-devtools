# mcp-repo-devtools

[![CI](https://github.com/MAOLVLHL/mcp-repo-devtools/actions/workflows/ci.yml/badge.svg)](https://github.com/MAOLVLHL/mcp-repo-devtools/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/mcp-repo-devtools?label=npm)](https://www.npmjs.com/package/mcp-repo-devtools)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![node >= 20.11](https://img.shields.io/badge/node-%E2%89%A520.11-informational)

**An agent that can read a whole log file will read a whole log file.**

`mcp-repo-devtools` is the tool surface a coding agent calls before it touches a
repository — working tree, history, issues, failing CI, pull-request context — plus a
reference loop that uses those tools and an eval that scores that loop against a model
holding nothing but `git`. Every result has a hard budget, every query has a hard
boundary, and both are measured rather than asserted.

It is built for the agent end of MCP, not for a human clicking through a UI: six tools
declared read-only, structured results a host can read as fields, progress and
cancellation for calls that take twenty seconds, a human gate in front of a write, and a
byte budget on every answer. Works with **Claude Code**, **Cursor**, **Codex**,
**Copilot** and any other MCP host.

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

## Built for an agent

The protocol is the product here: every feature below exists because a model, not a
person, is on the other end of the call.

| What the agent needs | What the server gives it |
| --- | --- |
| choose a tool without reading prose | `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` on all nine tools, plus one paragraph of usage instructions at `initialize` |
| read fields, not lines | `outputSchema` and `structuredContent` on the six read tools; the text stays for hosts that only render text |
| not look dead during a 20 s call | one `notifications/progress` per GitHub hop when the client sends a `progressToken`; the last event equals the total |
| stop work it no longer needs | the caller's abort signal reaches `fetch` and `execFile`; a cancel is reported as `cancelled by the client`, not as a timeout |
| keep its context small | 64 KB / 200 lines per result, and a tail line that names the argument narrowing the next call |
| trade a lossy clip for a summary | `MCP_SAMPLING_COMPRESSION=1` lets the client's own model summarise an over-budget result, with the clip as the fallback |
| act only when a human says so | `elicitation` puts a person in front of all three writes; `MCP_CONFIRM_WRITES=1` fails closed when the client cannot ask |
| know the order to call things in | three prompts (`diagnose-ci`, `review-pr`, `triage-issues`) that render a plan, not a tool |
| prove the tool helped | `src/agent/` is a loop over the same tools, and `eval/` scores it against raw `git` — publishing the result even when it loses |

## Quickstart

The package is not on npm yet, so the release tarball is the installable artifact today:

```bash
npm install -g https://github.com/MAOLVLHL/mcp-repo-devtools/releases/download/v0.3.0/mcp-repo-devtools-0.3.0.tgz
mcp-repo-devtools --version        # 0.3.0
mcp-repo-devtools --help           # prints the env contract and exits
```

Until the publish lands, use the global binary `mcp-repo-devtools` wherever a client
config below says `npx -y mcp-repo-devtools`. Once it is on npm, `npx` is the
zero-install path and nothing else changes.

The server speaks MCP over stdio. Three variables matter:

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

Every tool also answers a machine, not only a model. The six read tools declare an
`outputSchema` and return the same data as `structuredContent` next to the text, so a
host can read fields instead of parsing lines; all nine tools carry
`readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint`, and the server sends
one paragraph of usage instructions when a client connects. Annotations are hints, not
permissions — write tools stay unregistered unless `MCP_ENABLE_WRITE=1`.

A call that spans several GitHub hops can take ten to thirty seconds. If the client
sends a `progressToken`, `gh_ci_failures` reports one progress notification per hop
(check runs, then each run's jobs, then each job's log), so the host can show the step
instead of a spinner; the last notification equals the total. Without a token nothing
is sent and the result is unchanged. Cancelling the call aborts the in-flight `fetch`
and the running `git` process.

Full argument tables, example output, the exact truncation notes and what each layer
carries: [`docs/tools.md`](docs/tools.md).

## If you are the agent reading this

Five rules that keep a call cheap, learned from the eval rather than guessed:

1. `git_status` first. It names the branch and the changed paths, which is how you
   choose between `git_diff` and `git_log` instead of calling both.
2. When a result says `truncated`, narrow it. The tail line names the argument — pass
   `path=`, `base=` or a smaller `log_lines`. Re-running the same call wider spends the
   same budget again.
3. `gh_ci_failures` without `include_logs` is one round trip. Ask for the log only after
   the failing job is known, and ask for 40 lines, not the archive.
4. `gh_pr_context` replaces four REST calls. If you are about to fetch a PR, then its
   files, then its reviews separately, call this instead.
5. A write returns `isError: true` when a human declined it. Read the note and change the
   plan; do not send the same call again.

## Three prompts, two optional client features

A tool list is not a workflow. The server also registers three prompts — `diagnose-ci`,
`review-pr` and `triage-issues` — that a host can offer as slash commands. Each renders a
short, ordered plan over the read tools ("call `gh_ci_failures` with include_logs=true,
then map the log line to a file with `git_log`") and ends by saying what not to do: no
edits, no comments, no issues. They are prompts, not tools: nothing runs until the model
calls one.

Two client capabilities change how calls behave, and both are off unless you ask for
them, so the default surface is unchanged:

- **Confirmation before a write.** If the client advertises `elicitation`, the three write
  tools ask a human first ("Approve this GitHub write?" with the action, target and title)
  and send nothing when the answer is no — the refusal comes back as a normal tool error
  with the reason. `MCP_CONFIRM_WRITES=1` refuses when the client *cannot* ask (fail
  closed); `MCP_CONFIRM_WRITES=0` never asks. Unset means: ask when possible, proceed
  when the client has no way to ask.
- **Summarising instead of clipping.** `MCP_SAMPLING_COMPRESSION=1` lets an over-budget
  result be summarised by the client's own model instead of cut at 64 KB / 200 lines. The
  summary keeps identifiers, paths and error strings, is labelled
  `…compressed from N bytes by the client model`, and falls back to the ordinary clip if
  the model fails, times out or returns nothing. Results that already fit are byte-identical
  and never sent to the model.

Redaction runs before either feature, so a summary cannot bring back a secret the clip path
would have removed.

## Reference agent

The server is not an agent: it holds no loop, no planning and no memory between calls.
[`src/agent/`](src/agent/) is the smallest loop that is one, built on the same six read
tools, answering one question — *which commit introduced this CI failure?*

```bash
npm run demo:agent     # offline: a failing CI call, a real git log, a report
```

```text
src/agent/provider.ts   Provider seam; OpenAI-compatible and scripted implementations
src/agent/mcp-tools.ts  the server's tools as a toolbox a model can call
src/agent/loop.ts       turn/tool loop with turn, call and byte caps
src/agent/diagnose.ts   the CI-failure task: system prompt, target, run
src/agent/cli.ts        node dist/agent/cli.js --repo owner/name --ref main
```

`runAgent` sends the conversation, executes the tool calls that come back, appends the
results, and stops when the model answers without calling a tool. Caps: 8 turns, 4 calls
per turn, 24 KiB per result. The run is read-only by construction — it connects with
`enableWrite: false`, so the three write tools are never registered — and it reports why
it stopped (`final`, `max-turns`, `cancelled`). A tool that throws, or a call whose
arguments were not valid JSON, becomes a tool result with `isError: true` rather than an
exception. The provider seam is one method, so the same loop runs against OpenAI, an
Ollama or vLLM endpoint, or a scripted list of turns in the tests.

Details, including how to point it at any OpenAI-compatible gateway:
[`docs/agent.md`](docs/agent.md).

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

## An eval that can fail me

Most tool READMEs quote a benchmark their tool wins. This one runs mine against the boring
alternative, and **the boring alternative wins on cost** — same score, half the tokens. That
is the point.

[`eval/`](eval/) measures answers, not bytes: thirty offline fixtures, each a real repository
baked from a few commits with one regression in it, the failing test as a user would report
it, and the sha that introduced it. Both arms run the same loop, the same prompt and the
same 8-turn cap; the only variable is the tool surface — the six MCP tools, or one raw
`git` tool that returns its output verbatim.

```bash
npm run eval             # scripted oracle, offline, must be 30/30
npm run eval:baseline    # the same cases through the raw git tool
npm run eval:check       # the run above, per fixture, against eval/baseline.json
OPENAI_API_KEY=… npm run eval -- --provider openai   # a real model, real numbers
```

Scored from the trajectory, not a second opinion: success@1 (does the report name the
culprit commit), turns, tool calls, duplicate calls, tokens, and read-only violations. No
judge model, so the number cannot drift with the grader. The scripted oracle run must stay
30/30 — it proves fixtures, tool names and grader agree before a token is spent.

Three runs per arm, 2026-11-11, `deepseek-flash` at temperature 0, turn cap 8, thirty
fixtures — 90 cases per arm:

| | six MCP tools | one raw `git` tool |
| --- | --- | --- |
| success@1 | 90/90 (100%) | 90/90 (100%) |
| mean turns | 4.59 | 4.08 |
| mean tool calls | 6.72 | 6.71 |
| mean tokens per case | 12,893 | **5,851** |

On "which commit introduced this regression" both arms name the right commit every time, and
one raw command does it for 2.2× fewer tokens. The six schemas cost about 1,073 tokens on
every turn before a single result is read; the raw arm pays that once for one tool. And this
is the task `git` was built for — `log -p` and `show` are one call each — so a typed surface
has to earn its overhead somewhere else.

An eval you are willing to lose is the only kind worth quoting, and this one has already
paid for itself five times:

- it **caught the harness being unfair to its own author**: the first table read 87% for the
  typed arm because the task demanded a full sha while `git_log` prints seven characters, so
  models padded the right commit with 33 invented ones. The prompt was wrong, not the
  models; fixing it moved that arm from 87% to 100% and left the token gap untouched;
- it caught a **broken fixture** — the "culprit" commit could not fail the failing test, and
  the model said so; the oracle could never have caught it, because it cites the expected sha
  by construction;
- it caught a **loop bug** — a reply with no text was scored as an answer, so a model that
  stopped mid-thought looked wrong when the harness was wrong;
- it put a number on the **schema tax**, which decides whether a seventh tool is worth its
  tokens;
- it says where the server *should* win and the baseline cannot follow: `gh_ci_failures`,
  `gh_pr_context` and `gh_issue_search` reach GitHub state that a git-only tool cannot.

Method, the thirty regressions, the per-fixture table and the caveats:
[`docs/eval.md`](docs/eval.md).

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
- **Not an agent runtime.** The server has no loop, no planning and no memory between
  calls. `src/agent/` is a client of it — read-only, one task, not exposed as a tool — and
  `eval/` is how that client is judged, against a baseline that currently wins.
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
npm test             # build + node:test, 135 tests
npm run snapshot     # rewrite tests/fixtures/tool-surface.json after a surface change
npm run bench        # the measurement above (needs a checkout, and a token for GitHub rows)
npm run inspect      # MCP Inspector against the built server
npm run demo:agent   # the reference loop, offline, no key
npm run eval         # the thirty fixtures through the oracle, offline
npm run eval:check   # the gate: no fixture the recorded baseline solved got worse
```

The tool surface is a contract: `tests/contract.test.ts` fails if a tool appears,
disappears, or changes its arguments without the snapshot being updated on purpose.

If you are a coding agent working *in* this repository rather than installing it, read
[`AGENTS.md`](AGENTS.md): the commands, the six rules a change must not break, and where
each layer lives.

```text
src/config.ts   MCP_ALLOWED_ROOTS parsing and realpath containment
src/git.ts      execFile wrapper, allowlists, status/log/diff
src/github.ts   REST reads, CI log download, opt-in writes
src/zip.ts      minimal zip reader for Actions log archives
src/text.ts     output budget, log tail, credential redaction
src/server.ts   tool registration and text formatting
src/agent/      reference loop: provider, toolbox, loop, diagnose task, CLI
src/eval/       task-level eval: fixtures, grading, two arms, CLI
src/index.ts    stdio entry point
```

Docs: [architecture](docs/architecture.md) · [tool reference](docs/tools.md) ·
[reference agent](docs/agent.md) · [eval](docs/eval.md) · [security model](docs/security.md) ·
[measurements](bench/README.md).

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