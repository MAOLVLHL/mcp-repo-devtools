# Measured, not estimated

Every number in the README's table comes from `bench/measure.mjs`. It runs the built
server over stdio as a real MCP client, calls each tool, and compares the bytes it
returned against the bytes the obvious alternative returns.

The alternative is deliberately the *good* version of what an agent does without this
server: the same git command, the same GitHub endpoint, the same job logs, with no
truncation and no summarising. If the comparison were against a strawman, the numbers
would be worthless.

## What is compared

| Case | Alternative (naive) | This server |
| --- | --- | --- |
| `git_log` | `git log -n 20 -p --format=…` — full patches for 20 commits | one line per commit, hash / date / author / subject |
| `git_diff` | `git diff HEAD~5` — the full patch | `--stat` for the same base; `mode: "patch"` if you want the diff |
| `gh_issue_search` | `GET /search/issues?per_page=30`, raw JSON | 10 issues, one block each, body cut to a 160-character excerpt |
| `gh_ci_failures` | the full downloadable log of every failed job | failed steps only, plus the last 40 lines of up to three job logs |
| `git_status` | `git status --porcelain -b --untracked-files=all` | the same, capped at 200 entries with an explicit truncation line |

The `git_log`, `git_diff` and `git_status` rows run against generated fixtures, so
anyone can reproduce them without a private repository: one fixture has 60 commits of
ordinary code churn, the other has 400 dirty files and a file with a 4,000-element
array on one line. The GitHub rows run against a live public repository
(`HKUDS/nanobot`) and a real failed workflow run, fetched at the time of measurement.

## Results

Measured 2026-11-11 on Windows 11, Node `v22.14.0`, git `2.56.0.windows.4`.
Tokens are bytes / 4, which is a rough conversion, not a tokenizer count.

| Case | Naive bytes | Tool bytes | Saved | Naive ms | Tool ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| `git_log` — 20 commits, `git log -p` | 19,300 | 992 | 94.9% | 48 | 46 |
| `git_diff` — HEAD~5, patch vs stat | 3,641 | 290 | 92.0% | 38 | 41 |
| `gh_issue_search` — nanobot, raw JSON vs 10 issues | 176,170 | 4,371 | 97.5% | 1,525 | 1,200 |
| `gh_ci_failures` — nanobot run 42998518695, 3 failed jobs | 322,887 | 13,915 | 95.7% | 5,149 | 10,378 |
| `git_status` — 400 dirty files, capped at 200 | 8,320 | 5,621 | 32.4% | 85 | 88 |
| `git_diff` — 400 dirty, patch vs stat | 75,960 | 5,236 | 93.1% | 205 | 221 |
| `git_diff` — 400 dirty, patch mode under the 64 KB cap | 75,960 | 5,491 | 92.8% | 205 | 212 |

Raw JSON, including the probe results below: [`results/latest.json`](results/latest.json).

## Boundary probes

The same run fires four requests that must be refused. All four are, in the server,
before any subprocess or HTTP call:

| Probe | Result |
| --- | --- |
| `git_status` with `repo` outside `MCP_ALLOWED_ROOTS` | `Error: repository … is outside MCP_ALLOWED_ROOTS` |
| `git_diff` with `base` = `--output=/tmp/x` | `Error: base is not a valid git ref` |
| `git_diff` with `base` = `HEAD; echo pwned` | `Error: base is not a valid git ref` |
| `gh_issue_search` with `repo` = `not a repo` | `Error: repo must look like owner/name` |

## Caveats

These are honest limits, not disclaimers to skip:

- **n = 1 per cell.** These are single runs, not medians. GitHub latency moved by
  more than a second between two runs of the same call.
- **`gh_ci_failures` is slower than the naive path (10.4 s vs 5.1 s).** It resolves
  the ref to a commit, then to check runs, then to jobs, then downloads up to three
  logs — four round trips where the naive path downloads logs it already knows about.
  The trade is bytes for latency; whether that is a good trade depends on your context
  budget, not on this benchmark.
- **`git_status` saves the least (32.4%).** Below 200 dirty files the cap never
  fires, so the only difference is formatting. That is the intended behaviour: the
  cap protects the pathological case, it does not shrink the normal one.
- **Bytes are not tokens.** The conversion assumes 4 bytes per token, which is wrong
  for non-ASCII text and for JSON punctuation. It is consistent across cases, which is
  what the comparison needs.
- **The log download path is not a zip on every request.** GitHub serves job logs as
  either a zip archive or plain text with a BOM and runner timestamps; both are
  handled, and the measurement above happens to have hit the plain-text shape.

## Reproduce

```bash
npm run build
GITHUB_TOKEN=… node bench/measure.mjs --repo /path/to/checkout \
  --gh HKUDS/nanobot --ci-repo HKUDS/nanobot
```

Without `GITHUB_TOKEN` the two GitHub rows run against the anonymous rate limit and
may be skipped; the git rows always run. Pass `--json out.json` to keep a copy.
