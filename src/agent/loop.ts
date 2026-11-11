/**
 * The loop: ask the model, run whatever tools it asked for, feed the results
 * back, stop when it answers or when the turn budget runs out.
 *
 * Deliberately small. There is no planner and no second agent: one model, one
 * tool surface, a hard turn cap, and every step reported to the caller so a
 * long run can be watched instead of guessed at.
 */

import type { AgentToolbox, ToolOutcome } from "./mcp-tools.js";
import type { ConversationMessage, Provider, ToolCall } from "./provider.js";

export const DEFAULT_MAX_TURNS = 8;
/** A model that asks for ten tools at once is usually flailing; cap what one turn can do. */
export const DEFAULT_MAX_TOOL_CALLS_PER_TURN = 4;
export const DEFAULT_MAX_TOOL_RESULT_BYTES = 24 * 1024;
/** How many times an empty reply is answered with "you have not answered yet" before giving up. */
export const MAX_EMPTY_REPLIES = 2;

const EMPTY_REPLY_NUDGE =
  "Your last reply was empty. Answer the task now: the report, with the headings it asked for, " +
  "and no tool calls.";

export interface AgentLimits {
  maxTurns?: number;
  maxToolCallsPerTurn?: number;
  maxToolResultBytes?: number;
}

export type AgentEvent =
  | { type: "turn"; turn: number }
  | { type: "tool"; name: string; arguments: Record<string, unknown> }
  | { type: "result"; name: string; isError: boolean; bytes: number }
  | { type: "final"; text: string }
  | { type: "limit"; reason: string };

export interface AgentRun {
  /** The last thing the model said: the report when it finished, otherwise its working notes. */
  text: string;
  stopReason: "final" | "max-turns" | "cancelled";
  turns: number;
  toolCalls: number;
  /** Tokens the provider reported, summed over turns; zero when it reports none. */
  usage: { input: number; output: number };
  /** The conversation after the system prompt, for logging and for eval. */
  messages: ConversationMessage[];
}

export interface AgentOptions {
  provider: Provider;
  toolbox: AgentToolbox;
  system: string;
  task: string;
  limits?: AgentLimits;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
}

function lastAssistantText(messages: ConversationMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message !== undefined && message.role === "assistant" && message.text.trim().length > 0) {
      return message.text;
    }
  }
  return "";
}

export async function runAgent(options: AgentOptions): Promise<AgentRun> {
  const maxTurns = options.limits?.maxTurns ?? DEFAULT_MAX_TURNS;
  const perTurn = options.limits?.maxToolCallsPerTurn ?? DEFAULT_MAX_TOOL_CALLS_PER_TURN;
  const maxBytes = options.limits?.maxToolResultBytes ?? DEFAULT_MAX_TOOL_RESULT_BYTES;
  const emit = options.onEvent ?? (() => undefined);

  const messages: ConversationMessage[] = [{ role: "user", text: options.task }];
  let turn = 0;
  let toolCalls = 0;
  let emptyReplies = 0;
  const usage = { input: 0, output: 0 };

  while (turn < maxTurns) {
    if (options.signal?.aborted === true) {
      return { text: lastAssistantText(messages), stopReason: "cancelled", turns: turn, toolCalls, usage, messages };
    }
    turn += 1;
    emit({ type: "turn", turn });

    const reply = await options.provider.complete({
      system: options.system,
      // A snapshot: a provider that keeps the array must not watch later turns mutate it.
      messages: [...messages],
      tools: options.toolbox.specs,
      signal: options.signal,
    });
    if (reply.usage !== undefined) {
      usage.input += reply.usage.input;
      usage.output += reply.usage.output;
    }
    messages.push({ role: "assistant", text: reply.text, toolCalls: reply.toolCalls });

    if (reply.toolCalls.length === 0) {
      // A model that stops mid-thought returns no text and no calls; ending the run there
      // would score an empty answer as final. Ask once more, then accept the silence.
      if (reply.text.trim().length === 0 && emptyReplies < MAX_EMPTY_REPLIES && turn < maxTurns) {
        emptyReplies += 1;
        messages.push({ role: "user", text: EMPTY_REPLY_NUDGE });
        continue;
      }
      emit({ type: "final", text: reply.text });
      return { text: reply.text, stopReason: "final", turns: turn, toolCalls, usage, messages };
    }

    const executed = reply.toolCalls.slice(0, perTurn);
    for (const call of executed) {
      emit({ type: "tool", name: call.name, arguments: call.arguments });
      let outcome: ToolOutcome;
      try {
        outcome = await options.toolbox.call(call, maxBytes);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outcome = { text: "The tool call failed: " + message, isError: true };
      }
      toolCalls += 1;
      emit({
        type: "result",
        name: call.name,
        isError: outcome.isError,
        bytes: Buffer.byteLength(outcome.text, "utf8"),
      });
      messages.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        text: outcome.text,
        isError: outcome.isError,
      });
    }
    for (const call of reply.toolCalls.slice(perTurn)) {
      messages.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        text:
          "Not executed: this turn asked for more than " + String(perTurn) +
          " tool calls. Ask again with fewer, or use one broad call first.",
        isError: true,
      });
    }
  }

  emit({ type: "limit", reason: "max-turns" });
  return { text: lastAssistantText(messages), stopReason: "max-turns", turns: turn, toolCalls, usage, messages };
}

/** A one-line summary for a CLI or a log line. */
export function describeRun(run: AgentRun): string {
  const calls = run.toolCalls === 1 ? "1 tool call" : String(run.toolCalls) + " tool calls";
  const turns = run.turns === 1 ? "1 turn" : String(run.turns) + " turns";
  return "stopped (" + run.stopReason + ") after " + turns + ", " + calls;
}

/** Convenience for callers that only need the report text. */
export async function finalText(run: AgentRun): Promise<string> {
  return run.text.trim().length > 0 ? run.text.trim() : "No answer: " + describeRun(run);
}
