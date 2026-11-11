# Contributing

Thanks for looking. This is a small, deliberately narrow server; the most useful
contributions are the ones that keep it narrow.

## Before you write code

Open an issue for anything larger than a typo or a one-line fix, and say what the
current behaviour is, what you expected, and which tool it affects. A reproducible
command is worth more than a paragraph.

## Set up

```bash
npm install
npm run build
npm test          # builds, then runs every test with node:test
```

Node 20.11 or newer. There are no native dependencies and no test framework beyond
`node:test`, so a clean checkout needs nothing else.

## What a PR needs

- **Tests.** A bug fix comes with a test that fails on `main` and passes with the fix.
  If the behaviour is hard to test end to end, test the pure function it delegates to
  (`src/text.ts` and `src/config.ts` exist for exactly that reason).
- **A surface diff, if the surface changed.** `tests/contract.test.ts` compares the
  registered tools against `tests/fixtures/tool-surface.json`. If you add a tool or
  change an argument, run `npm run snapshot` and include the diff — that file is the
  review record for what a model will see.
- **Evidence for a claim about size.** If the PR says "returns much less", include the
  before/after bytes from `npm run bench` or a one-off script. The README's numbers are
  measured; new ones should be too.
- **No new runtime dependencies** unless the alternative is worse than the dependency.
  `@modelcontextprotocol/sdk` and `zod` are the whole list.
- **Conventional commits**: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `ci:`,
  `chore:`. One logical change per commit.

## Adding a tool

A new tool is a security decision, not just a feature: it widens what a model can reach.
In the PR, state:

1. what the tool can touch (paths, subprocesses, network hosts);
2. which allowlist it goes through, or why it needs a new one;
3. its output budget and what the truncation note says;
4. one example invocation and its measured output size.

Tools that run arbitrary commands, write files outside `MCP_ALLOWED_ROOTS`, or hide
their output size will be declined.

## Style

TypeScript strict, ESM, `.js` extensions on relative imports (Node's resolver, not a
bundler). Prefer a small pure function in `src/text.ts` over logic inside a tool
handler. Comments explain *why*, not *what*.

## Security

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).

## License

By contributing you agree your work is licensed under the MIT license in [LICENSE](LICENSE).
