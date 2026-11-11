# AGENTS.md

Notes for a coding agent working in this repository (Claude Code, Codex, Cursor,
Copilot, or anything else that reads `AGENTS.md`). `README.md` is for people who
install the server; this file is for the ones who change it.

## Commands

```bash
npm install
npm run build                 # tsc -> dist/ ; the tests import from src, the bin from dist
npm test                      # build + node:test (154 tests) — run it before every commit
npm run snapshot              # rewrite tests/fixtures/tool-surface.json after a surface change
npm run eval                  # forty fixtures through the scripted oracle, offline, 40/40
npm run eval:baseline         # the raw git arm on the thirty git fixtures: 30/30. The ten
                              # CI cases are scored on both arms; four of them are shallow
                              # (depth-1 clone), so the raw arm cannot answer them at all,
                              # and no miss is waived on either side
npm run eval -- --kind github # only the ten fixtures whose evidence is a CI log
npm run eval:check            # this run against eval/baseline.json, per fixture
npm run demo:agent            # the reference loop end to end, offline, no key
node --import tsx --test tests/<file>.test.ts   # one file while iterating
```

On Windows, `npm test` needs `git` on `PATH`: the route-a test shells out to it, and
the suite fails with `spawnSync git ENOENT` when it is missing.

## Non-negotiables

1. **The tool surface is a contract.** `tests/fixtures/tool-surface.json` locks the
   name, arguments, annotations and output schema of every tool. A change there is a
   review artefact, not an accident: regenerate it with `npm run snapshot` and include
   the diff in the pull request.
2. **The rendered text is byte-identical unless the change is about the text.** Hosts
   and `bench/measure.mjs` compare bytes; `tests/structured-output.test.ts` asserts the
   strings. A new field belongs in `structuredContent`, not in the middle of a table.
3. **Read-only stays the default.** Tools that write live inside `if (writeEnabled)` in
   `src/server.ts` and go through `requestWriteApproval`; nothing else may write.
4. **No new runtime dependencies.** `@modelcontextprotocol/sdk` and `zod` are the whole
   dependency list; a feature that needs a library is a design question, not a PR.
5. **Every result has a budget.** Whatever you add goes through `redact()` and
   `clip()` (or `redactDeep()` for structured content) before it reaches the model.
6. **The eval is allowed to say the server lost.** Do not tune fixtures or scoring to
   make the six-tool arm win; publish the number and explain it.
7. **A fixture is green at the culprit's parent and red at HEAD.** If the test suite
   passes on both sides, the fixture grades nothing — fix it before it reaches a run.
   A `kind: "github"` fixture keeps a real test suite too; only its evidence changes.
   A `shallow` fixture is still checked the same way, on the commits in its JSON; what
   is deleted is the baked repository's history, not the fixture's own trail. In a shallow
   fixture the run tested a later commit than the culprit, and the log's blame and
   `show --stat` lines are the only place the culprit's sha appears — keep it that way, or
   the fixture stops separating the arms (it did once: the raw arm scored 10/10).
8. **The baseline is recorded, not lowered.** Adding a fixture or changing the model means
   re-recording `eval/baseline.json` with three runs and `npm run eval:record`; a
   regression it reports is a finding, and `--max-regressions` is not the fix.

## Where things live

```text
src/git.ts          the only place that runs git: allowlist, flag denylist, argv, timeouts
src/github.ts       REST reads, log download, opt-in writes, progress per hop
src/text.ts         the 64 KB / 200 line budget, tail, credential redaction
src/server.ts       tool registration, annotations, output schemas, prompts, capability gates
src/agent/          the reference loop: Provider, toolbox, loop caps, diagnose task, CLI
src/eval/           fixtures, grader, two arms, CLI
docs/               architecture, tool reference, agent, eval, security
bench/              the byte measurements and their caveats
```

## Conventions

- TypeScript, ESM, Node >= 20.11, strict `tsconfig`. No `any` in exported signatures.
- Tests use `node:test` + `node:assert/strict`; GitHub is stubbed with a fake `fetch`,
  git is exercised against a temporary repository, and the MCP round trip uses
  `InMemoryTransport`.
- Errors carry the next action ("set GITHUB_TOKEN", "narrow with path="), never a stack.
- Commit messages follow Conventional Commits (`feat(scope): …`, `fix(scope): …`,
  `docs: …`), and a behaviour change lands with its test.

## Changing the protocol surface

Adding a tool, a prompt or a capability is a four-step change: implement it behind the
existing seam (`guarded`/`guardedStructured`), declare the metadata, snapshot the
contract, and document it in `docs/tools.md`. Anything a client may lack must degrade
to the behaviour that existed before it — that rule is why the three optional
capabilities (prompts, elicitation, sampling) are seams rather than dependencies.