import assert from "node:assert/strict";
import test from "node:test";

import {
  OpenAIProvider,
  ProviderError,
  ScriptedProvider,
  providerFromEnv,
  type ProviderRequest,
} from "../src/agent/provider.js";

interface Captured {
  url: string;
  init: RequestInit;
}

function stubFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): { calls: Captured[]; restore(): void } {
  const calls: Captured[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as typeof fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function request(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    system: "You are a release engineer.",
    messages: [{ role: "user", text: "why is CI red" }],
    tools: [],
    ...overrides,
  };
}

const TOOL = {
  name: "git_log",
  description: "Recent commits",
  inputSchema: { type: "object", properties: { limit: { type: "number" } } },
};

test("sends the system prompt, the tools and the key", async () => {
  const stub = stubFetch(() => json({ choices: [{ message: { content: "ok" } }] }));
  try {
    const provider = new OpenAIProvider({
      apiKey: "sk-test",
      baseUrl: "https://example.test/v1/",
      model: "m1",
      temperature: 0,
      fetchImpl: fetch,
    });
    const turn = await provider.complete(
      request({
        tools: [TOOL],
        messages: [
          { role: "user", text: "why is CI red" },
          { role: "assistant", text: "checking", toolCalls: [{ id: "c1", name: "git_log", arguments: { limit: 3 } }] },
          { role: "tool", toolCallId: "c1", name: "git_log", text: "abc123", isError: false },
        ],
      }),
    );

    assert.equal(turn.text, "ok");
    assert.deepEqual(turn.toolCalls, []);
    assert.equal(stub.calls.length, 1);
    const call = stub.calls[0];
    assert.equal(call?.url, "https://example.test/v1/chat/completions");
    const headers = call?.init.headers as Record<string, string>;
    assert.equal(headers.authorization, "Bearer sk-test");

    const body = JSON.parse(String(call?.init.body)) as Record<string, any>;
    assert.equal(body.model, "m1");
    assert.equal(body.messages[0].role, "system");
    assert.equal(body.messages[0].content, "You are a release engineer.");
    assert.equal(body.messages[1].content, "why is CI red");
    assert.equal(body.messages[2].tool_calls[0].id, "c1");
    assert.equal(body.messages[2].tool_calls[0].function.name, "git_log");
    assert.equal(body.messages[2].tool_calls[0].function.arguments, '{"limit":3}');
    assert.equal(body.messages[3].tool_call_id, "c1");
    assert.equal(body.tools[0].function.name, "git_log");
    assert.deepEqual(body.tools[0].function.parameters, TOOL.inputSchema);
    assert.equal(body.tool_choice, "auto");
  } finally {
    stub.restore();
  }
});

test("omits the tools key when the toolbox is empty", async () => {
  const stub = stubFetch(() => json({ choices: [{ message: { content: "ok" } }] }));
  try {
    const provider = new OpenAIProvider({ apiKey: "sk-test", fetchImpl: fetch });
    await provider.complete(request());
    const body = JSON.parse(String(stub.calls[0]?.init.body)) as Record<string, unknown>;
    assert.equal("tools" in body, false);
    assert.equal("tool_choice" in body, false);
  } finally {
    stub.restore();
  }
});

test("parses text, tool calls and usage", async () => {
  const stub = stubFetch(() =>
    json({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [{ id: "c9", function: { name: "git_log", arguments: '{"limit":1}' } }],
          },
        },
      ],
      usage: { prompt_tokens: 120, completion_tokens: 30 },
    }),
  );
  try {
    const provider = new OpenAIProvider({ apiKey: "sk-test", fetchImpl: fetch });
    const turn = await provider.complete(request());
    assert.equal(turn.text, "");
    assert.deepEqual(turn.toolCalls, [{ id: "c9", name: "git_log", arguments: { limit: 1 } }]);
    assert.deepEqual(turn.usage, { input: 120, output: 30 });
  } finally {
    stub.restore();
  }
});

test("marks arguments that are not JSON instead of failing the run", async () => {
  const stub = stubFetch(() =>
    json({
      choices: [{ message: { content: "", tool_calls: [{ id: "c1", function: { name: "git_log", arguments: "{oops" } }] } }],
    }),
  );
  try {
    const provider = new OpenAIProvider({ apiKey: "sk-test", fetchImpl: fetch });
    const turn = await provider.complete(request());
    assert.equal(turn.toolCalls.length, 1);
    assert.deepEqual(turn.toolCalls[0]?.arguments, {});
    assert.match(turn.toolCalls[0]?.argumentsError ?? "", /not valid JSON/);
  } finally {
    stub.restore();
  }
});

test("reports an HTTP failure with its status and a short body", async () => {
  const stub = stubFetch(() => new Response("invalid api key", { status: 401 }));
  try {
    const provider = new OpenAIProvider({ apiKey: "sk-test", fetchImpl: fetch });
    await assert.rejects(
      () => provider.complete(request()),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError);
        assert.equal(error.status, 401);
        assert.match(error.message, /401/);
        assert.match(error.message, /invalid api key/);
        return true;
      },
    );
  } finally {
    stub.restore();
  }
});

test("rejects a body that is not JSON", async () => {
  const stub = stubFetch(() => new Response("<html>gateway</html>", { status: 200 }));
  try {
    const provider = new OpenAIProvider({ apiKey: "sk-test", fetchImpl: fetch });
    await assert.rejects(() => provider.complete(request()), /not JSON/);
  } finally {
    stub.restore();
  }
});

test("rejects a payload with no choices", async () => {
  const stub = stubFetch(() => json({ choices: [] }));
  try {
    const provider = new OpenAIProvider({ apiKey: "sk-test", fetchImpl: fetch });
    await assert.rejects(() => provider.complete(request()), /no choices/);
  } finally {
    stub.restore();
  }
});

test("refuses to start without a key", () => {
  assert.throws(() => new OpenAIProvider({ apiKey: "   " }), ProviderError);
  assert.throws(() => providerFromEnv({}), /OPENAI_API_KEY is not set/);
});

test("reads the endpoint from the environment, letting flags win", () => {
  const provider = providerFromEnv(
    { OPENAI_API_KEY: "sk-env", OPENAI_BASE_URL: "https://env.test/v1", OPENAI_MODEL: "env-model" },
    { model: "flag-model" },
  );
  assert.equal(provider.model, "flag-model");
  assert.equal(provider.name, "openai-compatible");
});

test("the scripted provider replays turns in order and fails loudly when empty", async () => {
  const provider = new ScriptedProvider([
    (incoming) => ({ text: "saw " + String(incoming.messages.length) + " messages", toolCalls: [] }),
  ]);
  const turn = await provider.complete(request());
  assert.equal(turn.text, "saw 1 messages");
  assert.equal(provider.requests.length, 1);
  await assert.rejects(() => provider.complete(request()), /ran out of turns/);
});
