# Task-level eval

The benchmark in [`bench/`](../bench/README.md) answers *how many bytes did the tool
save*. It cannot answer *did the agent get the answer right*, because it never runs one.
This directory is the second question.

## What a case is

Thirty fixtures in [`fixtures/`](fixtures/), each a JSON file with three things:

- `commits` — the repository, baked commit by commit with fixed dates, so every build
  produces the same shas;
- `symptom` — the failing test, phrased the way a user would paste it into a chat;
- `expected_commit` — the 1-based index of the commit that actually introduced the
  regression.

Every fixture carries a real, runnable test suite: the repository is green at the culprit's
parent and red at HEAD. That property is checked, not assumed — a fixture whose test never
fails is a fixture that grades nothing, and `float-equality-breaks-total` was exactly that
until a model refused to answer it (see below).

Nothing touches the network. A case builds in milliseconds, which is what makes it cheap
enough to run on every commit.

### The thirty regressions

| Fixture | What the culprit broke |
| --- | --- |
| `cache-key-drops-the-tenant` | the cache key lost the tenant, so two tenants read each other's rows |
| `csv-export-quotes-nothing` | a hand-built `join` replaced the csv module, so commas are no longer quoted |
| `flag-parser-rejects-one` | a boolean parser narrowed to `true`/`false`, so `ENABLED=1` stops working |
| `float-equality-breaks-total` | rounding dropped from a money total, so `0.1 + 0.2` no longer equals `0.3` |
| `json-fixture-loses-unicode` | `ensure_ascii` turned back on, so the snapshot holds `\u00e9` instead of `é` |
| `pagination-repeats-first-page` | the page number used as an offset, so page 2 repeats page 1 |
| `query-loses-the-tenant-filter` | filtering moved out of SQL and into Python, dropping the tenant predicate |
| `refresh-token-keyerror` | the token read directly from a response that may omit it |
| `report-dates-drift-by-timezone` | a timestamp switched from UTC to local time |
| `retry-loop-no-longer-backs-off` | the sleep removed from a retry loop |
| `sort-order-depends-on-locale` | a sort made case-insensitive, so `Banana` now sorts before `apple` |
| `split-drops-the-remainder-cent` | shares computed in one pass, so a split of 100 into three parts sums to 99 |
| `slug-regex-consumes-underscore` | the slug character class simplified, so `_` becomes `-` |
| `page-slice-off-by-one` | a "never return more than a page" guard, so the second page loses its last row |
| `dedupe-keeps-first-not-last` | ids skipped once seen, so the first write wins instead of the last |
| `shared-default-list-accumulates` | a mutable default argument, so two calls share one list |
| `frozen-dataclass-loses-hash` | `frozen=True` dropped, so values are no longer hashable |
| `cursor-skips-the-boundary-row` | a cursor guard that drops the row sitting exactly on the boundary |
| `rate-limit-window-is-closed` | a half-open window turned closed, so a request on the boundary counts |
| `unicode-nfc-compare-dropped` | normalisation removed, so two spellings of the same name stop comparing equal |
| `float-cents-truncated` | the round before the cast dropped, so `19.99` becomes `1998` cents |
| `timeout-unit-swapped` | a timeout in seconds passed where milliseconds are expected |
| `deep-merge-became-shallow` | a spread instead of a merge, so overriding one key drops its siblings |
| `sort-mutates-the-callers-array` | an in-place sort, so the caller's array is reordered |
| `async-cache-races-on-miss` | the value awaited before it is cached, so two concurrent callers both miss |
| `header-lookup-lowercased-twice` | a lower-case name looked up directly in a case-sensitive map |
| `config-read-at-import-time` | configuration built once at import, so a later `process.env` change is ignored |
| `email-pattern-loses-its-anchor` | the pattern allowed to match anywhere, so trailing text is accepted |
| `clamp-arguments-swapped` | `min` and `max` folded in the wrong order, so an above-ceiling value lands below the floor |
| `parse-int-accepts-trailing-junk` | `parseInt` used for the cast, so port `8080abc` is accepted |

Python fixtures run under `pytest`, JavaScript fixtures under `node --test`; the language
is a property of the repository, not of the grader.

## The two arms

| Arm | Tool surface | What it represents |
| --- | --- | --- |
| `mcp` | the six read tools, over an in-memory transport | this server |
| `baseline` | one `git` tool that runs a command and returns the output verbatim | the good version of "just use a shell" |

Both arms use the same loop, the same system prompt, the same task, and the same 8-turn
cap. The only variable is the tool surface, which is the point: a difference in tokens or
turns is attributable to the tools, not to a different agent.

The baseline is deliberately *good*: it accepts any read-only git subcommand, it is not
truncated to 64 KB, and it returns stdout exactly. A baseline that is crippled proves
nothing.

## What is scored

```text
success@1        the report's "Introduced by" section names the culprit commit
turns            loop turns spent
tool calls       calls made, including the ones that failed
duplicates       calls that repeated an earlier call with the same tool and arguments
tokens           input + output as the provider reported them; zero for a scripted run
violations       write tools or unknown tools, i.e. a broken read-only promise
```

Success is exact: the cited sha must be a prefix of the culprit (or the other way round)
and must not be another commit from the same fixture. A plausible paragraph that blames
the wrong commit is a wrong answer, however well written.

A model that stops without writing anything gets one more turn, twice, before its silence
is taken as the answer. That is a property of the loop, not of the grader, and it is why a
run can report more turns than tool calls suggest.

Grading is done from the trajectory the loop returns — no second model, no judge, no
rubric drift. The same run and the same fixture always produce the same score.

The tools print abbreviated shas (`git log --pretty=%h`), and the task asks for the sha
"exactly as the history printed it". Any prefix of the culprit counts. A short sha padded
with invented characters does not: it is a false identifier, and the grader treats it as
one, which is the same rule the server applies to a claim it cannot verify.

## Running it

```bash
npm run build

npm run eval                      # scripted oracle: must be 30/30
npm run eval:baseline             # the same cases through the raw git tool
npm run eval:check                # that run, compared against eval/baseline.json
OPENAI_API_KEY=… npm run eval -- --provider openai
OPENAI_API_KEY=… OPENAI_MODEL=gpt-4o-mini npm run eval -- --provider openai --json
```

The scripted provider is an oracle: it replays `git log`, the one diff that matters, and
a report that cites the expected sha. It proves the fixtures, the tool names, the loop
and the grader agree — if the harness scores 29/30, the harness is broken, not the model.
That is the run CI enforces.

The `openai` provider is a real model behind any OpenAI-compatible endpoint. Its numbers
are the ones worth quoting, and they are only meaningful next to the arm, the model name
and the turn cap.

A case that raises — a dead endpoint, a rejected key, a provider that answers 502 — is
printed as `ERROR` and the suite keeps going, because one bad response should not throw
away twenty-nine good ones. The CLI then exits 1 and lists the cases that did not finish,
so a half-run can never be mistaken for a low score.

## A real model, on the thirty fixtures

Three runs per arm, 2026-11-11, `deepseek-flash` at temperature 0, turn cap 8 — 90 cases per
arm:

| | six MCP tools | one raw `git` tool |
| --- | --- | --- |
| success@1 | 90/90 (100%) | 90/90 (100%) |
| mean turns | 4.59 | 4.08 |
| mean tool calls | 6.72 | 6.71 |
| mean tokens per case | 12,893 | **5,851** |
| duplicate calls | 0% | 0.3% |
| read-only violations | 0 | 0 |

Both arms solve every case, so on this task the typed surface buys correctness it already
had and costs 2.2× the tokens. The gap is mostly the schema tax: six tool schemas are about
4,290 bytes, roughly 1,073 tokens on every turn before a result is read, and the raw arm
pays it once for a single tool.

### The first number was wrong, and that is the finding

The first version of this table read 87% for the typed arm, and the loss looked like
vocabulary mismatch. It was not. The task prompt asked for "the full commit sha" while
`git_log` prints `%h` — the typed arm could not produce a full sha at all, so a model that
had identified the right commit copied its seven characters and invented thirty-three more.
Every one of those failures was a right commit behind a fabricated identifier, and the raw
arm was unaffected because a shell can ask git for `%H`.

The fix belongs in the task, not the grader: the prompt now asks for the sha "exactly as the
history printed it", and a padded sha is still scored as a fabrication
(`tests/eval-grade.test.ts` pins both halves). The typed arm moved from 87% to 100% — better
for the arm, and a reminder that a harness can lose a comparison on its own author's behalf.

## The gate: a recorded run, not a target

A single model run is a coin flip, so it cannot be a threshold. What can be a threshold is
the *set of fixtures that run solved*: `eval/baseline.json` records, per fixture, whether
a majority of three runs got it right, together with the model, the arm and the date.

```bash
npm run eval:check                                    # scripted run against the record
node dist/eval/cli.js --provider openai --check eval/baseline.json
```

The comparison prints the gate, the rate now against the rate recorded, and the three
lists that matter:

```text
gate: FAIL  ·  deepseek-official/deepseek-flash (mcp, 3 runs, 2026-11-11)
measured 96.7% now vs 100.0% recorded  ·  1 regression(s), 0 recovered, 0 unmeasured
regressed: sort-mutates-the-callers-array
the recorded baseline solved 1 of these and this run did not; raise --max-regressions only on purpose
```

(That output is an illustration — the recorded baseline is 30/30, so any single lost fixture
prints exactly this.)

- **A regression** — recorded as passing, failing now — fails the run. This is the whole
  point of a per-fixture record: an average hides a swap, one fixture recovered and another
  lost still reads 86.7%, and the summary alone would call it fine.
- **A recovery** — recorded as failing, passing now — is printed and never fails. A model
  getting better is not an incident.
- **An unmeasured fixture** — one the record does not know — fails the run until someone
  re-records. Otherwise adding fixtures would silently narrow the gate to the old ones.
- `--max-regressions N` exists for a deliberate, reviewed trade. Raising it is an
  admission, not a fix, and the gate says so in its own output.

Re-recording is honest when the model or the fixtures legitimately changed:

```bash
# three runs of the same arm, then a majority verdict per fixture
node dist/eval/cli.js --provider openai --json > run-1.json   # …2, 3
npm run eval:record -- eval/baseline.json run-1.json run-2.json run-3.json
```

The recorder refuses to guess: a fixture missing from any of the runs is an error, not a
fail, because a gap in the record is a gap in the gate.

### In CI

`ci.yml` runs both arms through the scripted oracle and then `eval:check`, so a broken
fixture or a drifted harness fails a pull request without a model or a secret.
`eval-model.yml` is the measured half: `workflow_dispatch`, a repository secret
`OPENAI_API_KEY`, variables `OPENAI_BASE_URL` and `OPENAI_MODEL`, and the same
`--check`. It fails the workflow on a regression and uploads the JSON either way.

## What it does not measure

- **General coding ability.** One narrow task, thirty fixtures. A model that aces this may
  still be useless at everything else.
- **Latency.** Turns and tokens are counted; wall-clock time is not, because the fixture
  build and the provider are both local.
- **The quality of the prose.** Only the citation is checked. A correct sha with a
  hand-wavy explanation scores the same as a correct sha with a good one.
- **Multi-file archaeology.** Every fixture is small enough that one diff explains the
  failure. Real incidents are not.
- **The GitHub tools.** Every fixture is a local git repository, so `gh_ci_failures`,
  `gh_pr_context` and `gh_issue_search` — the tools the baseline cannot reach — are never
  scored. A tool surface that only pays off on the GitHub side would score exactly like the
  tables above.

## Adding a fixture

1. Write the commits so that exactly one of them changes behaviour the symptom describes.
2. Make the test suite actually catch it: green at the culprit's parent, red at HEAD. If
   the tests pass on both sides, the fixture grades nothing.
3. Put the failing test's message in `symptom`, including the assertion text when it
   helps.
4. Set `expected_commit` to that commit's 1-based position.
5. Run `npm run eval`; the oracle must stay 30/30 (or 31/31).
6. Add a line to the table above saying what the regression is.
7. Re-record `eval/baseline.json`, or `eval:check` will (correctly) fail on the new
   fixture as unmeasured.