# The reference agent

The MCP server is not an agent: it holds no loop and no memory between calls. This
directory is the smallest thing that *is* one, built on top of the same server, so the
tool surface can be exercised end to end instead of described in a README.

It answers one question about one CI failure:

> Which commit introduced this failure?

It reads. It never writes: the loop connects to the server with `enableWrite: false`,
so `gh_pr_create`, `gh_issue_create` and `gh_pr_comment` are not registered in the
process at all, and the workspace it is pointed at is only ever read by `git`.

## The loop

```text
            +-----------------------------------------------+
            |  system prompt + task + the 6 read tools      |
            v                                               |
   +------------------+     tool_calls    +-----------------+
   |   Provider       | ----------------> |  MCP server     |
   |  (one turn of    |                   |  (in process,   |
   |   the model)     | <---------------- |   read-only)    |
   +------------------+   tool results    +-----------------+
            |
            | no tool_calls  -> final text
            v
       the report
```

`runAgent` in [`src/agent/loop.ts`](../src/agent/loop.ts) owns that loop and nothing
else: it sends the conversation, executes the tool calls the model asked for, appends
the results, and stops when the model answers without calling a tool. Three caps keep a
confused model from spending the afternoon:

| Cap | Default | Where |
| --- | ---: | --- |
| turns | 8 | `DEFAULT_MAX_TURNS` |
| tool calls per turn | 4 | `DEFAULT_MAX_TOOL_CALLS_PER_TURN` |
| bytes per tool result | 24 KiB | `DEFAULT_MAX_TOOL_RESULT_BYTES` |

A run stops for one of three reasons — `final`, `max-turns`, `cancelled` — and every
one of them is reported. A tool that throws, or a call whose arguments were not valid
JSON, becomes a tool result with `isError: true`; the loop does not crash, because a
model that asked badly should get a chance to ask better.

## The provider seam

```ts
interface Provider {
  readonly name: string;
  complete(request: ProviderRequest): Promise<ModelTurn>;
}
```

`ProviderRequest` is `{ system, messages, tools, signal? }`; `ModelTurn` is
`{ text, toolCalls, usage? }`. Nothing in the loop knows about HTTP or about OpenAI.

Two implementations ship:

- **`OpenAIProvider`** — `POST {baseUrl}/chat/completions`, `baseUrl` defaulting to
  `https://api.openai.com/v1` and the model to `gpt-4o-mini`. It sends
  `tools`/`tool_choice: "auto"` only when there are tools, maps `tool_calls` back to
  `ToolCall`, and turns a non-2xx response into a `ProviderError` that carries the
  status and the first 300 characters of the body. Because it is a plain
  OpenAI-compatible endpoint, any gateway that speaks the same shape works:
  `--base-url http://localhost:11434/v1 --model llama3.1` (Ollama), a proxy, a
  self-hosted vLLM.
- **`ScriptedProvider`** — replays a fixed list of turns and records every request it
  received. This is what the tests use, so the loop is exercised without a key, without
  a network, and without pretending a model said something specific.

## The task

`runDiagnose` in [`src/agent/diagnose.ts`](../src/agent/diagnose.ts) supplies the
system prompt and the opening message, and connects the loop to a fresh in-process
server. The prompt asks for evidence first and then a report in four sections — *What
failed*, *Why*, *Introduced by*, *Next step* — under 200 words, with every sentence
traceable to a tool result. It also says what to do when the evidence is not there:
say so, rather than guess a commit.

The task is deliberately narrow. "Diagnose a red CI run" has a checkable answer, it
needs more than one tool (`gh_ci_failures` → `git_log` → `git_diff`), and it is the
thing a developer actually does next.

## Running it

```bash
npm run build

# Replay the loop offline, no key, no GitHub: a failing CI call, a real git log, a report.
npm run demo:agent

# The same loop against a real endpoint.
export OPENAI_API_KEY=sk-…
export GITHUB_TOKEN=ghp_…                     # gh_ci_failures needs it
node dist/agent/cli.js \
  --repo owner/name --ref main --worktree /absolute/path/to/checkout

# Any OpenAI-compatible gateway.
node dist/agent/cli.js --repo owner/name --ref main \
  --base-url http://localhost:11434/v1 --model llama3.1
```

The report goes to stdout; progress (`[turn 1]`, the tool that ran, its size, whether it
failed) goes to stderr, so `… | jq` and `> report.md` stay useful. `--json` prints the
whole `AgentRun` — messages, usage, stop reason — for a caller that wants the
trajectory rather than the prose.

Exit codes: `0` the model finished, `3` a cap was hit, `2` bad arguments or a missing
key, `1` anything else. Ctrl-C aborts the run through the same signal that cancels an
in-flight tool call, so the git process and the fetch do not outlive the command.

## What it is not

- **Not a coding agent.** It has no write tools registered and no ability to apply a
  patch. The output is an explanation a human acts on.
- **Not a benchmark.** There is no scoring harness here; the counts in the demo are
  what the loop did, not what a model is capable of.
- **Not a framework.** No planner, no sub-agents, no memory between runs. Adding any of
  those would be a different repository.
