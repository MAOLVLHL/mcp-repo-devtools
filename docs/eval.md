# Task-level eval

The benchmark in [`bench/`](../bench/README.md) answers *how many bytes did the tool
save*. It cannot answer *did the agent get the answer right*, because it never runs one.
This directory is the second question.

## What a case is

Forty fixtures in [`fixtures/`](fixtures/), each a JSON file with three things:

- `commits` — the repository, baked commit by commit with fixed dates, so every build
  produces the same shas;
- `symptom` — the failing test, phrased the way a user would paste it into a chat;
- `expected_commit` — the 1-based index of the commit that actually introduced the
  regression.

Thirty of them are `kind: "git"`: the history in the checkout is the evidence. Ten are
`kind: "github"` and carry a fourth key, `github`, holding a workflow run, its failing
jobs and the failing job's log — because some regressions are only explained by a CI log,
and a tool surface that cannot read one can only guess.

Four of the ten are also `shallow: true`: the checkout is baked as a depth-1 clone of the
commit the run tested — one commit, no parent, which is the shape `actions/checkout` with
`fetch-depth: 1` leaves behind. The commit that broke the test came earlier and was never
fetched, so its sha is reachable in exactly one place: the job log, where a diagnostic step
ran `git blame` over the changed lines and `git show --stat` over the commit. That is the
one case in this suite where a raw `git` tool cannot be right, not because it is crippled
but because the evidence it would need was deleted by the clone.

Every fixture carries a real, runnable test suite: the repository is green at the culprit's
parent and red at HEAD. That property is checked, not assumed — a fixture whose test never
fails is a fixture that grades nothing, and `float-equality-breaks-total` was exactly that
until a model refused to answer it (see below).

Nothing touches the network. A case builds in milliseconds, which is what makes it cheap
enough to run on every commit.

### The thirty git regressions

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

### The ten CI regressions

| Fixture | What the culprit broke |
| --- | --- |
| `ci-log-tenancy-lost-in-the-cache-key` | a "simplify" removed the tenant from the cache key, so two tenants now share entries |
| `ci-log-pagination-never-leaves-the-first-page` | the stop condition changed from "no cursor" to "empty page", so the pager loops to its own guard |
| `ci-log-totals-rounded-to-one-decimal` | invoice totals rounded to one decimal, so `10.01` prints as `10.00` |
| `ci-log-backoff-multiplied-in-milliseconds` | a multiplier added where the unit was already milliseconds, so the first retry waits 100 s |
| `ci-log-a-missing-user-stops-rejecting` | a missing user returned as `null` instead of rejecting, so the caller renders a blank profile |
| `ci-log-a-date-formatted-for-one-locale` | an ISO day replaced by `toLocaleDateString`, so the date depends on the runner's locale |

### The four shallow ones

| Fixture | What the culprit broke | Where the log names it |
| --- | --- | --- |
| `shallow-ci-midnight-rolls-back-a-day` | `astimezone(tz)` dropped, so a UTC evening lands on the previous local day | blame on the dropped call, `refactor: simplify the day calculation` |
| `shallow-ci-rounds-each-line-first` | each line rounded before summing, so a long invoice loses pennies | blame on the per-line `round`, `refactor: round each line as it is added` |
| `shallow-ci-port-parser-accepts-junk` | `Number` replaced by `parseInt`, so `8080abc` is a port | blame on the parser line, `refactor: use parseInt for the port` |
| `shallow-ci-slug-keeps-punctuation` | the slug regex narrowed to whitespace, so `Hello, World!` keeps its comma | blame on the regex, `refactor: replace runs of whitespace only` |

All four are still real repositories with real test suites: green at the culprit's parent,
red at HEAD, checked the same way as every other fixture. What is missing is the history the
green state came from — which is exactly what a `git clone --depth 1` in a CI job gives you.
The run itself tested a later commit (a docs-only change in each of the four), so the one
commit the clone holds is *not* the answer; the blame and `show --stat` lines are.

None of the ten is answerable from the checkout alone: the commits are ordinary-looking
refactors and the failing assertion is in the log. Six of them can still be *guessed* from
the diffs, because the culprit commit is in the history; the four shallow ones cannot, and
the measurement below changes because of it.

A `github` fixture is still a real repository with a real test suite: green at the
culprit's parent, red at HEAD, exactly like the git ones. Only the *evidence the model is
given* differs.

## The two arms

| Arm | Tool surface | What it represents |
| --- | --- | --- |
| `mcp` | the six read tools, over an in-memory transport | this server |
| `baseline` | one `git` tool that runs a command and returns the output verbatim | the good version of "just use a shell" |

Both arms run all forty fixtures when you ask for them. The raw arm is *scored* on
the thirty git fixtures (`npm run eval:baseline` passes `--kind git`): its one tool speaks
git, the evidence in a CI case is a workflow log on GitHub, and the scripted oracle has no
path to it.

### Where the CI kind separates the arms, and where it does not

The first six `github` fixtures were built to exercise `gh_ci_failures` end to end, not to
be unanswerable: their culprit commit is still in the history, so a raw `git` tool can find
it by reading diffs. Measured over three runs on the forty-fixture suite, the raw arm scored
**18/18** on those six, at 8,076 tokens per case against the typed arm's 16,964 — opening a
404 KB log costs more than the diffs it competes with.

The four shallow fixtures were built to close that hole structurally rather than rhetorically.
There is no diff to read: the checkout holds one commit, the run tested a later, docs-only
commit, and the sha that broke the build is in the log's blame and `show --stat` lines or
nowhere. A raw `git` tool can only name the one commit it can see, which is the wrong sha,
or decline — and the scripted raw arm declines, which is why `--arm baseline --kind all`
exits 1 and CI scores the raw arm on the git kind. This is the first place in the suite where
the typed surface wins on *correctness* rather than on presentation, and the reason is not
that the baseline is crippled: it is that the evidence it needs was deleted by the clone.

The first version of the four got this wrong, and the measurement caught it. It made the run's
`head_sha` *equal* to the culprit's sha, with the clone keeping that same commit — coherent,
but it meant the one commit a raw `git` tool could see was already the answer. Measured, the
raw arm scored **10/10** on the ten CI fixtures by citing it, at 6,671 tokens per case: the
four graded nothing. The fix was to move the culprit one commit back and have the log carry
the blame, which is also what a real incident looks like — the run is green-then-red on a
commit whose own diff is innocent.

A model can still decline to cite a sha it cannot verify locally. That is a legitimate
reading of the evidence and it is scored as a miss, not waived. The first probe on the
blame version of the fixtures still showed a model declining, because the two shas in the
log disagreed with the one in its clone; the log now says which commit the run checked out
and which commit it blames, and over three runs the typed arm answered all twelve shallow
cases while the raw arm answered none.

Nothing is waived either way. No miss is *expected* on any arm; a shallow fixture that the
raw arm solved would be a bug in the fixture, because the sha it would have to cite does not
exist anywhere in its input.

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

npm run eval                      # scripted oracle: must be 40/40
npm run eval:baseline             # the raw git tool, the thirty git cases (30/30)
npm run eval:check                # that run, compared against eval/baseline.json
npm run eval -- --kind github     # only the ten CI cases
OPENAI_API_KEY=… npm run eval -- --provider openai
OPENAI_API_KEY=… OPENAI_MODEL=gpt-4o-mini npm run eval -- --provider openai --json
```

The scripted provider is an oracle: it replays `git log`, the one diff that matters, and
a report that cites the expected sha. It proves the fixtures, the tool names, the loop
and the grader agree — if the harness scores 39/40, the harness is broken, not the model.
That is the run CI enforces.

The `openai` provider is a real model behind any OpenAI-compatible endpoint. Its numbers
are the ones worth quoting, and they are only meaningful next to the arm, the model name
and the turn cap.

A case that raises — a dead endpoint, a rejected key, a provider that answers 502 — is
printed as `ERROR` and the suite keeps going, because one bad response should not throw
away thirty-nine good ones. The CLI then exits 1 and lists the cases that did not finish,
so a half-run can never be mistaken for a low score.

## A real model, on the forty fixtures

Three runs per arm, 2026-11-11, `deepseek-flash` at temperature 0, turn cap 8 — 120 cases per
arm:

| | six MCP tools | one raw `git` tool |
| --- | --- | --- |
| success@1 | **120/120 (100%)** | 108/120 (90%) |
| mean turns | 4.68 | 4.72 |
| mean tool calls | 6.97 | 9.18 |
| mean tokens per case | 13,898 | **8,534** |
| duplicate calls | 0% | 0.5% |
| read-only violations | 0 | 0 |

Split by evidence, the arms trade the two things the suite measures:

| Evidence | six MCP tools | one raw `git` tool |
| --- | --- | --- |
| thirty git fixtures | 90/90, 13,567 tokens | 90/90, **6,548 tokens** |
| six CI-log fixtures | 18/18, 16,964 tokens | 18/18, **8,076 tokens** |
| four shallow fixtures | **12/12, 11,779 tokens** | 0/12, 24,118 tokens |

On a repository with its history intact the raw arm is right every time and costs 2.1× less:
the six schemas are about 4,290 bytes, roughly 1,073 tokens on every turn before a result is
read, and the raw arm pays that once for a single tool. On the depth-1 checkout it cannot be
right, and it does not save money trying — it spends twice the typed arm's tokens and 24.8
tool calls per case looking for a commit that was never fetched, then cites the one it can
see or declines. That is the case the typed surface exists for, and it is worth stating
precisely: the win is not that the tools are smarter, it is that `gh_ci_failures` reads the
log the clone left behind.

An overall score that hides this would be the wrong summary. Both numbers are above the
split, because "which arm is better" has no single answer here: it depends on whether the
evidence survived the clone.

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

- **General coding ability.** One narrow task, forty fixtures. A model that aces this may
  still be useless at everything else.
- **Latency.** Turns and tokens are counted; wall-clock time is not, because the fixture
  build and the provider are both local.
- **The quality of the prose.** Only the citation is checked. A correct sha with a
  hand-wavy explanation scores the same as a correct sha with a good one.
- **Multi-file archaeology.** Every fixture is small enough that one diff explains the
  failure. Real incidents are not.
- **GitHub beyond CI logs.** Ten fixtures now need `gh_ci_failures`, but `gh_pr_context`
  and `gh_issue_search` are still unscored: no fixture puts its evidence in a pull request
  or an issue. The GitHub side of the surface is measured, not exhausted.
- **Writing.** Both arms are read-only, so nothing here scores a tool that changes
  something.

## Adding a fixture

1. Write the commits so that exactly one of them changes behaviour the symptom describes.
2. Make the test suite actually catch it: green at the culprit's parent, red at HEAD. If
   the tests pass on both sides, the fixture grades nothing.
3. Put the failing test's message in `symptom`, including the assertion text when it
   helps.
4. Set `expected_commit` to that commit's 1-based position.
5. Run `npm run eval`; the oracle must stay green (40/40, or 41/41).
6. Add a line to the table above saying what the regression is.
7. Re-record `eval/baseline.json`, or `eval:check` will (correctly) fail on the new
   fixture as unmeasured.

For a `github` fixture there are two more rules. Add `kind: "github"` and a `github` block
with `repo`, `ref`, `run`, `sha`, `jobs` and `log`; the log must contain the line the model
is expected to quote, because that is the only evidence the fixture offers. Then check the
baseline arm still scores it as a miss — if a git command can answer it, the fixture is a
`git` fixture wearing a CI log.