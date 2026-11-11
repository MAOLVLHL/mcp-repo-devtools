/**
 * The model half of the agent loop.
 *
 * One interface, two implementations: an OpenAI-compatible HTTP provider for a
 * real run against any endpoint that speaks /chat/completions, and a scripted
 * provider so the loop, the tool bridge and the CLI can be tested without a
 * key, a network or a non-deterministic model.
 */

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments, as MCP already describes it. */
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** Set when the model sent arguments that are not a JSON object; the loop reports it back. */
  argumentsError?: string;
}

export type ConversationMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; text: string; isError: boolean };

export interface ProviderRequest {
  system: string;
  messages: ConversationMessage[];
  tools: ToolSpec[];
  signal?: AbortSignal;
}

export interface ModelTurn {
  text: string;
  toolCalls: ToolCall[];
  usage?: { input: number; output: number };
}

export interface Provider {
  readonly name: string;
  complete(request: ProviderRequest): Promise<ModelTurn>;
}

export class ProviderError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
  }
}

export interface OpenAIProviderOptions {
  apiKey: string;
  /** Anything that serves /chat/completions: OpenAI, a gateway, a local server. */
  baseUrl?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** Injected in tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

interface WireToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

interface WireMessage {
  role: string;
  content: string | null;
  tool_call_id?: string;
  tool_calls?: WireToolCall[];
}

interface ChatCompletion {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
    };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Longest error body echoed back: enough to debug, short enough not to flood a loop. */
const MAX_ERROR_BODY = 300;

export class OpenAIProvider implements Provider {
  readonly name = "openai-compatible";
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly temperature: number;
  private readonly maxTokens: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAIProviderOptions) {
    if (options.apiKey.trim().length === 0) {
      throw new ProviderError("an API key is required for the OpenAI-compatible provider");
    }
    this.apiKey = options.apiKey.trim();
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    this.model = options.model ?? "gpt-4o-mini";
    this.temperature = options.temperature ?? 0;
    this.maxTokens = options.maxTokens ?? 1500;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async complete(request: ProviderRequest): Promise<ModelTurn> {
    const body: Record<string, unknown> = {
      model: this.model,
      temperature: this.temperature,
      max_tokens: this.maxTokens,
      messages: [
        { role: "system", content: request.system },
        ...request.messages.map(toWireMessage),
      ],
    };
    if (request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
      }));
      body.tool_choice = "auto";
    }

    const response = await this.fetchImpl(this.baseUrl + "/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + this.apiKey,
      },
      body: JSON.stringify(body),
      signal: request.signal,
    });

    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).trim().slice(0, MAX_ERROR_BODY);
      throw new ProviderError(
        "the provider answered " + String(response.status) + (detail.length > 0 ? ": " + detail : ""),
        response.status,
      );
    }

    let payload: ChatCompletion;
    try {
      payload = (await response.json()) as ChatCompletion;
    } catch {
      throw new ProviderError("the provider returned a body that is not JSON", response.status);
    }

    const choice = payload.choices?.[0]?.message;
    if (choice === undefined) {
      throw new ProviderError("the provider returned no choices");
    }

    return {
      text: typeof choice.content === "string" ? choice.content : "",
      toolCalls: (choice.tool_calls ?? []).map((call, index) => toToolCall(call, index)),
      usage: payload.usage
        ? { input: payload.usage.prompt_tokens ?? 0, output: payload.usage.completion_tokens ?? 0 }
        : undefined,
    };
  }
}

function toWireMessage(message: ConversationMessage): WireMessage {
  if (message.role === "user") {
    return { role: "user", content: message.text };
  }
  if (message.role === "tool") {
    return { role: "tool", content: message.text, tool_call_id: message.toolCallId };
  }
  if (message.toolCalls.length === 0) {
    return { role: "assistant", content: message.text };
  }
  return {
    role: "assistant",
    content: message.text.length > 0 ? message.text : null,
    tool_calls: message.toolCalls.map((call: ToolCall) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    })),
  };
}

function toToolCall(
  call: { id?: string; function?: { name?: string; arguments?: string } },
  index: number,
): ToolCall {
  const name = call.function?.name ?? "";
  const raw = call.function?.arguments ?? "{}";
  const id = call.id ?? "call_" + String(index);
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { id, name, arguments: {}, argumentsError: "arguments were not a JSON object: " + raw.slice(0, 200) };
    }
    return { id, name, arguments: parsed as Record<string, unknown> };
  } catch {
    return { id, name, arguments: {}, argumentsError: "arguments were not valid JSON: " + raw.slice(0, 200) };
  }
}

/** One scripted turn: a fixed reply, or a function of the request (to inspect history). */
export type ScriptedTurn = ModelTurn | ((request: ProviderRequest) => ModelTurn | Promise<ModelTurn>);

export class ScriptedProvider implements Provider {
  readonly name = "scripted";
  readonly requests: ProviderRequest[] = [];
  private readonly turns: ScriptedTurn[];

  constructor(turns: ScriptedTurn[]) {
    this.turns = [...turns];
  }

  async complete(request: ProviderRequest): Promise<ModelTurn> {
    this.requests.push(request);
    const turn = this.turns.shift();
    if (turn === undefined) {
      throw new ProviderError(
        "the scripted provider ran out of turns after " + String(this.requests.length) + " request(s)",
      );
    }
    return typeof turn === "function" ? await turn(request) : turn;
  }
}

export interface ProviderOverrides {
  baseUrl?: string;
  model?: string;
}

/** Read the provider settings from the environment; one place that names the variables. */
export function providerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  overrides: ProviderOverrides = {},
): OpenAIProvider {
  const apiKey = env.OPENAI_API_KEY ?? "";
  if (apiKey.trim().length === 0) {
    throw new ProviderError(
      "OPENAI_API_KEY is not set. Export it, or point OPENAI_BASE_URL at an endpoint that does not need one.",
    );
  }
  return new OpenAIProvider({
    apiKey,
    baseUrl: overrides.baseUrl ?? env.OPENAI_BASE_URL,
    model: overrides.model ?? env.OPENAI_MODEL,
  });
}
