# Tool reference

Every tool returns plain text. Nothing returns JSON: the model reads this, so the
shapes are chosen to be read, not parsed. If a result was cut, the last line says so
and names the argument that narrows it.

Common rules:

- **Budget.** 64 KB / 200 lines per result, applied to the rendered text.
- **Redaction.** Every string passes through the credential redactor before it
  leaves the process (`ghp_`, `github_pat_`, `gho_`, `Bearer`, and PEM blocks).
- **No caching.** Each call observes the current state of the repository or the API.
- **Errors** come back with `isError: true` and a message that says what to do next.

---

## `git_status`

Summarise the working tree. Use it before `git_diff` so you know which paths are
worth diffing.

| Argument | Type | Default | Notes |
| --- | --- | --- | --- |
| `repo` | string | required | Absolute path to a git working tree inside `MCP_ALLOWED_ROOTS` |

```text
branch feat/progress-sidecar (upstream origin/feat/progress-sidecar)  +2 -0
3 changed path(s)
modified   src/core/log-tail.js
untracked  bench/measure.mjs
renamed    test/old.test.js
```

Cap: 200 entries. Past that, the last line is
`…truncated (more than 200 entries; use git_diff with path= to narrow)`.

---

## `git_log`

| Argument | Type | Default | Notes |
| --- | --- | --- | --- |
| `repo` | string | required | Absolute path |
| `path` | string | – | Scope history to a file or directory |
| `limit` | int 1–100 | `20` | Commits returned |

```text
2 commit(s) (path src/git.ts)
a1b2c3d  2026-11-11T10:00:00Z  MAOLVLHL  fix: reject refs that start with a dash
e4f5a6b  2026-11-10T09:12:00Z  MAOLVLHL  feat: add git_diff mode=patch
```

One line per commit. No patches, no merge graph: hand the hash to `git_diff` when
you actually need the change. That is the 94.9% in the benchmark.

---

## `git_diff`

| Argument | Type | Default | Notes |
| --- | --- | --- | --- |
| `repo` | string | required | Absolute path |
| `base` | string | `HEAD` | Rev, tag, branch or sha. Must match `^[A-Za-z0-9._/~^@{}=+:-]+$` and must not start with `-` |
| `path` | string | – | Scope the diff |
| `mode` | `stat` \| `patch` | `stat` | `patch` returns a unified diff |
| `context_lines` | int 0–50 | `3` | Hunk context in patch mode |

```text
diff (stat) against HEAD~5

 src/git.ts    | 12 +++++++-----
 src/server.ts |  4 ++--
 2 files changed, 10 insertions(+), 6 deletions(-)
```

Defaults to `stat` on purpose: a model that wants the patch usually wants one file's
patch. `mode: "patch"` still exists, and it is the only mode where the 64 KB cap
regularly fires — when it does, the note tells you to narrow with `path=` or lower
`context_lines=`.

---

## `gh_issue_search`

| Argument | Type | Default | Notes |
| --- | --- | --- | --- |
| `repo` | string | required | `owner/name` |
| `query` | string | `""` | GitHub search terms, e.g. `label:bug timeout` |
| `state` | `open` \| `closed` \| `all` | `open` | |
| `limit` | int 1–30 | `10` | |

```text
issues in HKUDS/nanobot matching "label:bug sse" (open)
total matches: 37

#1892 open SSE stream drops the last event on reconnect  [bug, P2]
   https://github.com/HKUDS/nanobot/issues/1892  updated 2026-11-10
   Server closes before flushing the final frame when…
```

Pull requests are filtered out even when GitHub's search returns them: an issue
search that silently includes PRs wastes a call and confuses the model about which
number accepts a comment.

---

## `gh_ci_failures`

| Argument | Type | Default | Notes |
| --- | --- | --- | --- |
| `repo` | string | required | `owner/name` |
| `ref` | string | required | Sha, branch, tag or PR head ref |
| `include_logs` | boolean | `false` | Fetch log tails for up to three failing jobs |
| `log_lines` | int 10–200 | `40` | Tail length per job |

```text
repo HKUDS/nanobot  ref 3f2a1c9b8d7e  (3f2a1c9b8d7e)
14 check run(s), 3 failing
  test (ubuntu)  failure
    failed steps: pytest
    log tail:
      …
      E   AssertionError: expected 200, got 502
```

The log is downloaded by following GitHub's redirect **without** the token, so the
credential never reaches the signed blob URL. GitHub serves that blob as either a zip
archive or plain text with a BOM and per-line runner timestamps; both are decoded in
process (`src/zip.ts`) and the timestamps are stripped before the tail is kept.

Costs: one request per job, up to three jobs. Logs older than 90 days come back as
`log unavailable: …` rather than failing the call.

---

## `gh_pr_context`

| Argument | Type | Default | Notes |
| --- | --- | --- | --- |
| `repo` | string | required | `owner/name` |
| `number` | int | required | Pull request number |

```text
repo o/r  PR #879  open
feat(api): resume event streams from Last-Event-ID
by @MAOLVLHL  develop <- feat/resumable-sse-streams
5 file(s), +761 -38

body: Adds id/Last-Event-ID…

files:
  modified  +120 -3  src/parlant/api/sessions.py
  added     +145 -0  src/parlant/api/sse.py
  …

reviews:
  @reviewer CHANGES_REQUESTED: two questions inline

review comments:
  src/parlant/api/sse.py:42 @reviewer — what happens if the id is malformed?
```

One call replaces four (`GET /pulls/{n}`, `/files`, `/reviews`, `/comments`). Files
are capped at 30 printed out of up to 100 fetched; review bodies are excerpts.

---

## Write tools (only with `MCP_ENABLE_WRITE=1`)

| Tool | Arguments | What it does |
| --- | --- | --- |
| `gh_pr_create` | `repo`, `title`, `head`, `base`, `body`, `draft` | Opens a PR from a branch that is **already pushed** |
| `gh_issue_create` | `repo`, `title`, `body`, `labels` | Files an issue |
| `gh_pr_comment` | `repo`, `number`, `body` | Comments on an issue or pull request |

What write mode cannot do: push, force-push, merge, close, delete a branch, create a
branch, edit files. Those need a shell this server does not have, or belong to the
agent's own git client.

Every write appends one line to stderr before the request goes out:

```text
[mcp-repo-devtools] write gh_pr_create MAOLVLHL/mcp-repo-devtools feat/x -> main
```

A failed write returns GitHub's own reason, not a stack trace:

```text
Error: GitHub refused (422): No commits between main and feat/x
```
