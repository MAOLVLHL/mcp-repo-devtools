import assert from "node:assert/strict";
import test from "node:test";

import { describeRun, runAgent, type AgentEvent } from "../src/agent/loop.js";
import type { AgentToolbox, ToolOutcome } from "../src/agent/mcp-tools.js";
import { ScriptedProvider, type ToolCall, type ToolSpec } from "../src/agent/provider.js";

const LOG_TOOL: ToolSpec = {
  name: "git_log",
  description: "Recent commits",
  inputSchema: { type: "object", properties: { limit: { type: "number" } } },
};

function toolbox(
  answers: Record<string, (call: ToolCall) => ToolOutcome | Promise<ToolOutcome>>,
): AgentToolbox & { seen: ToolCall[] } {
  const seen: ToolCall[] = [];
  return {
    specs: [LOG_TOOL],
    seen,
    async call(call: ToolCall): Promise<ToolOutcome> {
      seen.push(call);
      const handler = answers[call.name];
      if (handler === undefined) {
        return { text: "no such tool", isError: true };
      }
      return handler(call);
    },
  };
}

function call(id: string, name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id, name, arguments: args };
}

test("runs the requested tool, feeds the result back and returns the report", async () => {
  const provider = new ScriptedProvider([
    {
      text: "Looking at history.",
      toolCalls: [call("c1", "git_log", { limit: 5 })],
      usage: { input: 100, output: 20 },
    },
    { text: "Report: one commit broke it.", toolCalls: [], usage: { input: 50, output: 30 } },
  ]);
  const tools = toolbox({ git_log: () => ({ text: "abc123 feat: change things", isError: false }) });

  const run = await runAgent({ provider, toolbox: tools, system: "sys", task: "why is CI red" });

  assert.equal(run.text, "Report: one commit broke it.");
  assert.equal(run.stopReason, "final");
  assert.equal(run.turns, 2);
  assert.equal(run.toolCalls, 1);
  assert.deepEqual(run.usage, { input: 150, output: 50 });
  assert.deepEqual(tools.seen[0]?.arguments, { limit: 5 });

  assert.equal(run.messages.length, 4);
  assert.equal(run.messages[0]?.role, "user");
  assert.equal(run.messages[1]?.role, "assistant");
  const result = run.messages[2];
  assert.equal(result?.role, "tool");
  assert.equal(result?.role === "tool" ? result.toolCallId : null, "c1");
  assert.equal(result?.role === "tool" ? result.text : null, "abc123 feat: change things");

  assert.equal(provider.requests.length, 2);
  assert.equal(provider.requests[0]?.tools[0]?.name, "git_log");
  assert.equal(provider.requests[0]?.system, "sys");
  assert.equal(provider.requests[1]?.messages.length, 3);
});

test("reports each step in order", async () => {
  const provider = new ScriptedProvider([
    { text: "", toolCalls: [call("c1", "git_log")] },
    { text: "done", toolCalls: [] },
  ]);
  const events: AgentEvent[] = [];

  await runAgent({
    provider,
    toolbox: toolbox({ git_log: () => ({ text: "ok", isError: false }) }),
    system: "sys",
    task: "task",
    onEvent: (event) => events.push(event),
  });

  assert.deepEqual(
    events.map((event) => event.type),
    ["turn", "tool", "result", "turn", "final"],
  );
  const result = events[2];
  assert.equal(result?.type === "result" ? result.bytes : -1, 2);
  assert.equal(result?.type === "result" ? result.isError : null, false);
});

test("asks once more when the model stops without saying anything", async () => {
  const provider = new ScriptedProvider([
    { text: "   ", toolCalls: [] },
    { text: "## Introduced by\nabc123", toolCalls: [] },
  ]);

  const run = await runAgent({ provider, toolbox: toolbox({}), system: "sys", task: "task" });

  assert.equal(run.stopReason, "final");
  assert.equal(run.turns, 2);
  assert.match(run.text, /Introduced by/);
  assert.equal(provider.requests[1]?.messages.at(-1)?.role, "user");
});

test("gives up after two empty replies instead of looping", async () => {
  const provider = new ScriptedProvider([
    { text: "", toolCalls: [] },
    { text: "", toolCalls: [] },
    { text: "", toolCalls: [] },
  ]);

  const run = await runAgent({ provider, toolbox: toolbox({}), system: "sys", task: "task" });

  assert.equal(run.stopReason, "final");
  assert.equal(run.turns, 3);
  assert.equal(run.text, "");
  assert.equal(provider.requests.length, 3);
});

test("stops at the turn limit and says so", async () => {
  const provider = new ScriptedProvider([
    { text: "still working", toolCalls: [call("c1", "git_log")] },
    { text: "still working", toolCalls: [call("c2", "git_log")] },
  ]);
  const events: AgentEvent[] = [];

  const run = await runAgent({
    provider,
    toolbox: toolbox({ git_log: () => ({ text: "ok", isError: false }) }),
    system: "sys",
    task: "task",
    limits: { maxTurns: 2 },
    onEvent: (event) => events.push(event),
  });

  assert.equal(run.stopReason, "max-turns");
  assert.equal(run.turns, 2);
  assert.equal(run.text, "still working");
  assert.equal(events.at(-1)?.type, "limit");
  assert.match(describeRun(run), /stopped \(max-turns\) after 2 turns, 2 tool calls/);
});

test("executes only the per-turn cap and tells the model the rest was skipped", async () => {
  const provider = new ScriptedProvider([
    {
      text: "",
      toolCalls: [1, 2, 3].map((index) => call("c" + String(index), "git_log", { index })),
    },
    { text: "done", toolCalls: [] },
  ]);
  const tools = toolbox({ git_log: () => ({ text: "ok", isError: false }) });

  const run = await runAgent({
    provider,
    toolbox: tools,
    system: "sys",
    task: "task",
    limits: { maxToolCallsPerTurn: 2 },
  });

  assert.equal(run.toolCalls, 2);
  assert.equal(tools.seen.length, 2);
  const toolMessages = run.messages.filter((message) => message.role === "tool");
  assert.equal(toolMessages.length, 3);
  const skipped = toolMessages[2];
  assert.equal(skipped?.role === "tool" ? skipped.isError : null, true);
  assert.match(skipped?.role === "tool" ? skipped.text : "", /Not executed/);
});

test("turns a throwing toolbox into a tool result instead of ending the run", async () => {
  const provider = new ScriptedProvider([
    { text: "", toolCalls: [call("c1", "git_log")] },
    { text: "recovered", toolCalls: [] },
  ]);

  const run = await runAgent({
    provider,
    toolbox: toolbox({
      git_log: () => {
        throw new Error("spawn failed");
      },
    }),
    system: "sys",
    task: "task",
  });

  assert.equal(run.text, "recovered");
  const message = run.messages[2];
  assert.equal(message?.role === "tool" ? message.isError : null, true);
  assert.match(message?.role === "tool" ? message.text : "", /spawn failed/);
});

test("stops before the first turn when the signal is already aborted", async () => {
  const provider = new ScriptedProvider([{ text: "never", toolCalls: [] }]);
  const controller = new AbortController();
  controller.abort();

  const run = await runAgent({
    provider,
    toolbox: toolbox({}),
    system: "sys",
    task: "task",
    signal: controller.signal,
  });

  assert.equal(run.stopReason, "cancelled");
  assert.equal(run.turns, 0);
  assert.equal(provider.requests.length, 0);
});

test("reports zero usage when the provider reports none", async () => {
  const provider = new ScriptedProvider([{ text: "done", toolCalls: [] }]);
  const run = await runAgent({ provider, toolbox: toolbox({}), system: "s", task: "t" });
  assert.deepEqual(run.usage, { input: 0, output: 0 });
});
