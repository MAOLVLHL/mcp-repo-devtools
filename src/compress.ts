/**
 * Sampling-based compression: instead of cutting a long result at the output
 * budget, ask the client model to keep the parts another model needs.
 *
 * Opt-in, because it costs a model call and makes the output
 * non-deterministic. The clip stays the fallback, so a client without
 * sampling, a slow host and a failed request all produce exactly what this
 * server produced before.
 */

import type {
  CreateMessageRequestParamsBase,
  CreateMessageResult,
} from "@modelcontextprotocol/sdk/types.js";
import { MAX_OUTPUT_BYTES, MAX_OUTPUT_LINES, clip } from "./text.js";

/** The slice of McpServer this module needs; a stub object is enough to test it. */
export interface SamplingServer {
  server: {
    getClientCapabilities(): { sampling?: unknown } | undefined;
    createMessage(
      params: CreateMessageRequestParamsBase,
      options?: { signal?: AbortSignal; timeout?: number },
    ): Promise<CreateMessageResult>;
  };
}

export const COMPRESSION_TIMEOUT_MS = 20_000;
export const COMPRESSION_MAX_TOKENS = 800;
/** Never hand more than this to the client model: a 64 KB result is fine, a 4 MB one is not. */
export const MAX_SAMPLING_INPUT_BYTES = 256 * 1024;

export type CompressionMethod = "none" | "sampling" | "clip";

export interface CompressionOutcome {
  text: string;
  /** none = already inside the budget, sampling = compressed, clip = cut. */
  method: CompressionMethod;
}

export interface CompressionOptions {
  maxBytes?: number;
  maxLines?: number;
  hint?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** True when clip() would cut this text, without doing the work twice. */
export function isOverBudget(
  text: string,
  maxBytes: number = MAX_OUTPUT_BYTES,
  maxLines: number = MAX_OUTPUT_LINES,
): boolean {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (byteLength(normalized) > maxBytes) {
    return true;
  }
  return normalized.split("\n").length > maxLines;
}

export function samplingAvailable(server: SamplingServer): boolean {
  return server.server.getClientCapabilities()?.sampling !== undefined;
}

/**
 * The request sent to the client model. It asks for the identifiers, paths and
 * error strings that another agent cannot infer, and caps the reply so a
 * runaway summary cannot arrive larger than the text it replaced.
 */
export function compressionRequest(text: string): CreateMessageRequestParamsBase {
  const input = byteLength(text) > MAX_SAMPLING_INPUT_BYTES
    ? Buffer.from(text, "utf8").subarray(0, MAX_SAMPLING_INPUT_BYTES).toString("utf8")
    : text;
  return {
    systemPrompt:
      "You compress tool output for another coding agent. Keep identifiers, paths, numbers, error strings and the " +
      "order of events; drop repeated log noise, progress output and blank lines. Reply with the compressed text " +
      "only, no preamble, at most 2000 characters.",
    maxTokens: COMPRESSION_MAX_TOKENS,
    messages: [
      {
        role: "user",
        content: { type: "text", text: "Compress this tool output for another agent:\n\n" + input },
      },
    ],
  };
}

function textOf(result: CreateMessageResult): string {
  const content = result.content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("")
      .trim();
  }
  return content.type === "text" ? content.text.trim() : "";
}

/**
 * Shape one result: leave it alone when it fits, compress it when the client
 * can, and cut it otherwise. Never throws: a tool result is more useful
 * truncated than missing.
 */
export async function compressText(
  server: SamplingServer,
  text: string,
  options: CompressionOptions = {},
): Promise<CompressionOutcome> {
  const maxBytes = options.maxBytes ?? MAX_OUTPUT_BYTES;
  const maxLines = options.maxLines ?? MAX_OUTPUT_LINES;
  if (!isOverBudget(text, maxBytes, maxLines)) {
    return { text, method: "none" };
  }
  if (!samplingAvailable(server)) {
    return { text: clip(text, { maxBytes, maxLines, hint: options.hint }), method: "clip" };
  }

  const before = byteLength(text);
  try {
    const result = await server.server.createMessage(compressionRequest(text), {
      signal: options.signal,
      timeout: options.timeoutMs ?? COMPRESSION_TIMEOUT_MS,
    });
    const summary = textOf(result);
    if (summary.length === 0) {
      throw new Error("the client returned no text");
    }
    const header = "\u2026compressed from " + String(before) + " bytes by the client model\n\n";
    return {
      text: header + clip(summary, { maxBytes: Math.max(1024, maxBytes - byteLength(header)), maxLines, hint: options.hint }),
      method: "sampling",
    };
  } catch {
    return { text: clip(text, { maxBytes, maxLines, hint: options.hint }), method: "clip" };
  }
}
