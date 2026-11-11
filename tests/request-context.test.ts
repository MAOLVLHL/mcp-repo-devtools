import assert from "node:assert/strict";
import test from "node:test";

import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";

import { isCancellation, NO_CONTEXT, requestContext, withTimeout } from "../src/request-context.js";

interface SentNotification {
  method: string;
  params: {
    progressToken: string | number;
    progress: number;
    total?: number;
    message?: string;
  };
}

interface FakeOptions {
  token?: string | number;
  signal?: AbortSignal;
  fail?: boolean;
}

function fakeExtra(options: FakeOptions = {}) {
  const sent: SentNotification[] = [];
  const signal = options.signal ?? new AbortController().signal;
  const extra = {
    signal,
    requestId: 7,
    _meta: options.token === undefined ? {} : { progressToken: options.token },
    sendNotification: async (notification: ServerNotification) => {
      sent.push(notification as unknown as SentNotification);
      if (options.fail === true) {
        throw new Error("client is gone");
      }
    },
  } as unknown as RequestHandlerExtra<ServerRequest, ServerNotification>;
  return { extra, sent, signal };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("NO_CONTEXT accepts progress updates and carries no signal", () => {
  NO_CONTEXT.progress({ progress: 1, total: 2, message: "ignored" });
  assert.equal(NO_CONTEXT.signal, undefined);
});

test("without a progressToken nothing is sent to the client", async () => {
  const { extra, sent, signal } = fakeExtra();
  const context = requestContext(extra);

  context.progress({ progress: 1, message: "check runs" });
  await tick();

  assert.deepEqual(sent, []);
  assert.equal(context.signal, signal);
});

test("a progressToken turns updates into notifications/progress", async () => {
  const { extra, sent } = fakeExtra({ token: "abc" });
  const context = requestContext(extra);

  context.progress({ progress: 3, total: 10, message: "log for job 42" });
  await tick();

  assert.deepEqual(sent, [
    {
      method: "notifications/progress",
      params: { progressToken: "abc", progress: 3, total: 10, message: "log for job 42" },
    },
  ]);
});

test("progress never goes backwards, totals never dip below progress, messages are trimmed", async () => {
  const { extra, sent } = fakeExtra({ token: 1 });
  const context = requestContext(extra);
  const longMessage = "x".repeat(400);

  context.progress({ progress: -5, total: -9, message: longMessage });
  context.progress({ progress: 4, total: 2 });
  context.progress({ progress: Number.NaN });
  await tick();

  assert.equal(sent.length, 2);
  assert.equal(sent[0]?.params.progress, 0);
  assert.equal(sent[0]?.params.total, 0);
  assert.equal(sent[0]?.params.message, "x".repeat(200));
  assert.equal(sent[1]?.params.progress, 4);
  assert.equal(sent[1]?.params.total, 4);
  assert.equal(sent[1]?.params.message, undefined);
});

test("a failing sendNotification is swallowed instead of failing the tool", async () => {
  const { extra, sent } = fakeExtra({ token: "abc", fail: true });
  const context = requestContext(extra);

  context.progress({ progress: 1, message: "check runs" });
  await tick();

  assert.equal(sent.length, 1);
});

test("withTimeout aborts when the caller aborts", () => {
  const caller = new AbortController();
  const signal = withTimeout(caller.signal, 60_000);

  assert.equal(signal.aborted, false);
  caller.abort();
  assert.equal(signal.aborted, true);
});

test("withTimeout aborts on its own deadline even without a caller signal", async () => {
  const signal = withTimeout(undefined, 20);
  assert.equal(signal.aborted, false);

  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(signal.aborted, true);
});

test("isCancellation recognises an aborted caller and an AbortError", () => {
  const caller = new AbortController();
  const context = requestContext(fakeExtra({ token: "abc", signal: caller.signal }).extra);

  assert.equal(isCancellation(context, new Error("boom")), false);
  caller.abort();
  assert.equal(isCancellation(context, new Error("boom")), true);
  assert.equal(isCancellation(NO_CONTEXT, Object.assign(new Error("aborted"), { name: "AbortError" })), true);
  assert.equal(isCancellation(NO_CONTEXT, new Error("boom")), false);
});
