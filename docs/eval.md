# Task-level eval

The benchmark in [`bench/`](../bench/README.md) answers *how many bytes did the tool
save*. It cannot answer *did the agent get the answer right*, because it never runs one.
This directory is the second question.

## What a case is

Ten fixtures in [`fixtures/`](fixtures/), each a JSON file with three things:

- `commits` — the repository, baked commit by commit with fixed dates, so every build
  produces the same shas;
- `symptom` — the failing test, phrased the way a user would paste it into a chat;
- `expected_commit` — the 1-based index of the commit that actually introduced the
  regression.

The regressions are ordinary ones: a default dropped from a dict lookup, an off-by-one
in a paginator, a timestamp switched from UTC to local time, a cache key that lost the
tenant, a sleep removed from a retry loop, a query that lost its filter, a float compared
with `==`, `ensure_ascii` flipped back on, a boolean parser narrowed to `"true"`, and a
sort made case-insensitive.

Nothing touches the network. A case builds in milliseconds, which is what makes it
cheap enough to run on every commit.

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

## Running it

```bash
npm run build

npm run eval                      # scripted oracle: must be 10/10
npm run eval:baseline             # the same cases through the raw git tool
OPENAI_API_KEY=… npm run eval -- --provider openai
OPENAI_API_KEY=… OPENAI_MODEL=gpt-4o-mini npm run eval -- --provider openai --json
```

The scripted provider is an oracle: it replays `git log`, the one diff that matters, and
a report that cites the expected sha. It proves the fixtures, the tool names, the loop
and the grader agree — if the harness scores 9/10, the harness is broken, not the model.
That is the run CI should enforce.

The `openai` provider is a real model behind any OpenAI-compatible endpoint. Its numbers
are the ones worth quoting, and they are only meaningful next to the arm, the model name
and the turn cap.

A case that raises — a dead endpoint, a rejected key, a provider that answers 502 — is
printed as `ERROR` and the suite keeps going, because one bad response should not throw
away nine good ones. The CLI then exits 1 and lists the cases that did not finish, so a
half-run can never be mistaken for a low score.

## A real model, measured — and it prefers the baseline

A benchmark that cannot fail its author is a marketing table. This one is built so it can:
one task, two arms, a deterministic grader, and neither arm privileged. The first real
model to run it picked the boring arm and won, and the numbers below are the ones it
produced. They are published unedited, because a number you would not quote when it goes
against you is not a measurement.

2026-11-11, `deepseek-flash` behind an OpenAI-compatible endpoint, temperature 0,
`max_tokens` 1500 per turn, 8-turn cap, ten fixtures, three runs per arm. Thirty cases
per arm, same fixtures, same task text, same loop.

| Run | `mcp` | `baseline` |
| --- | --- | --- |
| 1 | 8/10 | 10/10 |
| 2 | 10/10 | 10/10 |
| 3 | 8/10 | 10/10 |
| **total** | **26/30 (87%)** | **30/30 (100%)** |

| | `mcp` | `baseline` |
| --- | --- | --- |
| mean turns | 5.30 | 5.03 |
| mean tool calls | 7.67 | 8.70 |
| mean tokens per case | 16,492 | **8,043** |
| duplicate calls | 0.5% | 0% |
| read-only violations | 0 | 0 |

Only four fixtures ever failed in the `mcp` arm, each twice out of three runs:
`flag-parser-rejects-one`, `float-equality-breaks-total`, `refresh-token-keyerror`,
`sort-order-depends-on-locale`. The baseline passed all ten, three times.

The result goes against the server, and it is published that way on purpose — a tool
README that only quotes wins teaches you nothing about when to reach for the tool. Two
effects account for most of the gap:

- **Schema tax.** The six tool schemas serialise to about 4,290 bytes, roughly 1,070
  tokens, and they are re-sent on every turn — around 5,400 tokens before the model reads a
  single result. The baseline sends one small schema.
- **Task shape.** "Find the commit that introduced this regression" is the job `git` was
  designed for: `log -p`, `show`, `blame` are one call each. A typed surface makes the
  model ask the question in the vocabulary this server chose, and the failure modes we saw
  were vocabulary mismatches, not wrong reasoning.

What would change the verdict, and is not measured here: a task where the raw command is
the wrong shape — CI failures across jobs, PR review context, issue search — where the
baseline cannot go at all because it only speaks git. A seventh typed tool is a bet that
this is where the value is; the eval above is the reason to make that bet deliberately
rather than by default.

### What the first run already paid for

Four findings, in the order they arrived. None of them would have surfaced from a
benchmark that only measured bytes saved.

1. **A broken fixture, found by the model.** In `float-equality-breaks-total` the commit
   labelled as the culprit changed `is_zero`, which the failing test never calls — no
   commit in that repository could have made the test fail. The model said so, every run,
   and refused to cite a sha. It was right; the fixture was wrong. The scripted oracle
   could not catch it, because it cites `expected_commit` by construction.
2. **A loop bug, found by a tie.** One arm answered with an empty final message, which the
   loop scored as an answer. A silent model was being recorded as a wrong model. The loop
   now asks once more (at most twice) before silence counts.
3. **The price of the surface.** Six schemas cost about 1,070 tokens on every turn, roughly
   5,400 tokens per run, before any result is read. That is now a number, not a worry, and
   it is the first thing to check before adding a seventh tool.
4. **The boundary that matters.** The baseline wins at git archaeology and cannot follow
   into GitHub state at all. The honest next move is to compete where the baseline cannot
   go — CI failures across jobs, PR review context — not to add another way to read a
   diff.

## What it does not measure

- **General coding ability.** One narrow task, ten fixtures. A model that aces this may
  still be useless at everything else.
- **Latency.** Turns and tokens are counted; wall-clock time is not, because the fixture
  build and the provider are both local.
- **The quality of the prose.** Only the citation is checked. A correct sha with a
  hand-wavy explanation scores the same as a correct sha with a good one.
- **Multi-file archaeology.** Every fixture is small enough that one diff explains the
  failure. Real incidents are not.
- **The GitHub tools.** Every fixture is a local git repository, so `gh_ci_failures`,
  `gh_pr_context` and `gh_issue_search` — the tools the baseline cannot reach — are never
  scored. A tool surface that only pays off on the GitHub side would score exactly like
  the table above.

## Adding a fixture

1. Write the commits so that exactly one of them changes behaviour the symptom describes.
2. Put the failing test's message in `symptom`, including the assertion text when it
   helps.
3. Set `expected_commit` to that commit's 1-based position.
4. Run `npm run eval`; the oracle must stay 10/10 (or 11/11).
5. Add a line to this file saying what the regression is.
