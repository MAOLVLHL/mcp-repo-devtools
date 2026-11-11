# Tool reference

Every tool returns text: the model reads it, so the shapes are chosen to be read
first. The six read tools also return the same data as `structuredContent`, for a
host that would rather read fields than lines; the text is not deprecated, and the
two never disagree. If a result was cut, the last line says so and names the
argument that narrows it.

Common rules:

- **Budget.** 64 KB / 200 lines per result, applied to the rendered text.
- **Redaction.** Every string passes through the credential redactor before it
  leaves the process (`ghp_`, `github_pat_`, `gho_`, `Bearer`, and PEM blocks).
- **No caching.** Each call observes the current state of the repository or the API.
- **Errors** come back with `isError: true` and a message that says what to do next.

## What a host gets

| Layer | Who reads it | Shape |
| --- | --- | --- |
| `content[0].text` | the model | The rendered result, redacted and clipped to 64 KB / 200 lines |
| `structuredContent` | the host | The same data as fields, validated against the tool's `outputSchema` before it is sent |
| `annotations` | the host | `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` |

`structuredContent` is present only on success, only for the six read tools, and only
because each of them declares an `outputSchema` — the SDK refuses to send a result
that does not match it. Write tools stay text-only: a created pull-request number
does not need a schema. A failure is `isError: true` with no structured content, so a
host never has to guess whether the fields are trustworthy.

Annotations are hints, not permissions. A host may use them to label or group tools,
but the protocol says clients must not make security decisions from a hint, and this
server agrees: the protection is that write tools are not registered at all unless
`MCP_ENABLE_WRITE=1`.

| Tools | `readOnlyHint` | `destructiveHint` | `idempotentHint` | `openWorldHint` |
| --- | --- | --- | --- | --- |
| `git_status`, `git_log`, `git_diff` | true | false | true | false |
| `gh_issue_search`, `gh_ci_failures`, `gh_pr_context` | true | false | true | true |
| `gh_pr_create`, `gh_issue_create`, `gh_pr_comment` | false | true | false | true |

## Progress and cancellation

A call that spans several GitHub hops (`gh_ci_failures` reads check runs, then a
run's jobs, then a job's log archive) can take ten to thirty seconds. While it runs
the server reports one progress notification per hop, so a client can show which
step it is on rather than a spinner.

- The first notification has no `total`: the number of failing runs is not known
  until the first response arrives, and a total that jumps is worse than none.
- `progress` is monotonic, never below zero, and the last notification equals
  `total`.
- Notifications are best effort. A client that does not send a `progressToken`
  receives nothing, and the result is byte-for-byte the same as a client that does.
- Everything the server fetches carries the request's abort signal, so cancelling
  the tool call aborts the in-flight `fetch` and the running `git` child process.

Clients that apply a single request timeout should enable `resetTimeoutOnProgress`,
otherwise a call longer than the default 60 seconds is cut off even though progress
is arriving.

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
`…truncated (more than 200 entries; use git_diff with path= to narrow)`, and
`truncated` is `true` in the structured copy.

Structured: `branch`, `upstream` (`null` when the branch has none), `ahead`,
`behind`, `changes[]` of `{ status, path }`, `truncated`.

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

Structured: `path` (`null` for the whole tree) and `commits[]` of
`{ hash, date, author, subject }`.

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

Structured: `base`, `path`, `mode`, `diff`, `truncated`. The `diff` field is capped
like the text, and `truncated: true` is the machine-readable version of the tail note.
The printed text keeps its generic `max_lines=` hint; the structured copy names
`context_lines=`, which is the argument that actually narrows a patch.

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

Structured: `repo`, `query`, `state`, `totalCount`, `issues[]` of
`{ number, title, state, labels, updatedAt, url, bodyExcerpt }`.

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

Structured: `repo`, `ref`, `sha`, `checkedRuns`, `failures[]` of
`{ name, conclusion, title, summary, detailsUrl, failedSteps, logTail, logNote }`.

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

Structured: every printed field, plus up to 100 `files[]` — more than the 30 the text
prints — with `filesTruncated` telling you when even that was cut. `changedFiles` is
GitHub's total, so it can exceed `files.length`.

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
