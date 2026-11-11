/**
 * The tool half of the agent loop: the agent is an MCP client of this very
 * server, connected over an in-memory transport.
 *
 * Going through the protocol rather than importing the handlers keeps one tool
 * surface: whatever the server advertises to Claude Code or Cursor is exactly
 * what the loop can call, annotations and output limits included.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, SERVER_NAME, VERSION, type ServerOptions } from "../server.js";
import { clip } from "../text.js";
import type { ToolCall, ToolSpec } from "./provider.js";

/** Tool results are cut before they enter the model context; the server already did 64 KB. */
export const MAX_TOOL_RESULT_BYTES = 24 * 1024;

export interface ToolOutcome {
  text: string;
  isError: boolean;
}

export interface AgentToolbox {
  specs: ToolSpec[];
  call(call: ToolCall, maxBytes?: number): Promise<ToolOutcome>;
}

export interface InProcessServer {
  client: Client;
  specs: ToolSpec[];
  close(): Promise<void>;
}

export async function connectInProcess(options: ServerOptions = {}): Promise<InProcessServer> {
  const server = createServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "mcp-repo-devtools-agent", version: VERSION },
    { capabilities: {} },
  );
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const specs = await toolSpecs(client);
  return {
    client,
    specs,
    async close(): Promise<void> {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    },
  };
}

/** The tool list as the provider wants it: MCP name, description and input schema. */
export async function toolSpecs(client: Client): Promise<ToolSpec[]> {
  const { tools } = await client.listTools();
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    inputSchema: (tool.inputSchema ?? { type: "object" }) as Record<string, unknown>,
  }));
}

function textOf(result: unknown): string {
  const content = result !== null && typeof result === "object" ? (result as { content?: unknown }).content : undefined;
  const blocks = Array.isArray(content) ? content : [];
  const parts: string[] = [];
  for (const block of blocks as Array<{ type?: string; text?: string }>) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

/**
 * Run one tool call and always answer: a thrown error becomes a tool result,
 * because a model that is told what went wrong can recover, and a loop that
 * dies cannot.
 */
export async function callTool(
  client: Client,
  call: ToolCall,
  maxBytes: number = MAX_TOOL_RESULT_BYTES,
): Promise<ToolOutcome> {
  if (call.argumentsError !== undefined) {
    return { text: "The call was not executed: " + call.argumentsError, isError: true };
  }
  try {
    const result = await client.callTool({ name: call.name, arguments: call.arguments });
    return {
      text: clip(textOf(result), { maxBytes, maxLines: 400 }),
      isError: result.isError === true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { text: "The tool call failed: " + message, isError: true };
  }
}

/** Build a toolbox from an already connected client, for tests with a stub transport. */
export async function toolboxFor(client: Client): Promise<AgentToolbox> {
  return {
    specs: await toolSpecs(client),
    call: (call: ToolCall, maxBytes?: number) => callTool(client, call, maxBytes),
  };
}

/** The name is used in log lines only; exported so the CLI and tests agree. */
export const AGENT_CLIENT_NAME = SERVER_NAME + "-agent";
