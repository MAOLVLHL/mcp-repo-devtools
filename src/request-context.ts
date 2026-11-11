/**
 * Per-request progress and cancellation. An MCP request carries both: an
 * AbortSignal that fires when the client cancels, and an optional
 * progressToken that makes notifications/progress a stream the client can
 * display while a slow tool is still running.
 *
 * The context is passed explicitly rather than stored globally, so every
 * function that can block says out loud that it can be cancelled.
 */

import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  ProgressNotificationParams,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";

/** One step of a longer operation, shaped like the protocol's progress payload. */
export interface ProgressUpdate {
  /** Steps completed so far. Must not decrease over the life of a request. */
  progress: number;
  /** Total steps, once it is known. Omitted while the work is still being sized. */
  total?: number;
  /** Short line for a human, e.g. "log for job 812". */
  message?: string;
}

export interface RequestContext {
  /** Fires when the client cancels the call. Undefined outside a request. */
  readonly signal?: AbortSignal;
  /** A no-op when the client did not ask for progress. */
  progress(update: ProgressUpdate): void;
}

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** Keep a notification from turning into a log line per token. */
const MAX_MESSAGE_CHARS = 200;

/** Context for direct callers and tests: nothing to cancel, nobody listening. */
export const NO_CONTEXT: RequestContext = {
  signal: undefined,
  progress: () => {},
};

/**
 * Build the context a tool handler works with. Progress is a no-op unless the
 * client supplied a progressToken, so a host that does not ask pays nothing.
 */
export function requestContext(extra: ToolExtra): RequestContext {
  const token = extra._meta?.progressToken;
  return {
    signal: extra.signal,
    progress: (update: ProgressUpdate): void => {
      if (token === undefined || !Number.isFinite(update.progress)) {
        return;
      }
      const progress = Math.max(0, Math.trunc(update.progress));
      const params: ProgressNotificationParams = { progressToken: token, progress };
      if (update.total !== undefined && Number.isFinite(update.total)) {
        params.total = Math.max(progress, Math.trunc(update.total));
      }
      if (update.message) {
        params.message = update.message.slice(0, MAX_MESSAGE_CHARS);
      }
      const notification: ServerNotification = { method: "notifications/progress", params };
      // Best effort: a client that went away must not fail the tool.
      void extra.sendNotification(notification).catch(() => {});
    },
  };
}

/**
 * Combine the caller's cancellation with this call's own deadline. Aborting
 * either one stops the underlying fetch or child process; the client's signal
 * is not swallowed by the timeout and vice versa.
 */
export function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const deadline = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

/** True when a failure is the client cancelling, not the request going wrong. */
export function isCancellation(context: RequestContext, error: unknown): boolean {
  if (context.signal?.aborted === true) {
    return true;
  }
  return error instanceof Error && error.name === "AbortError";
}
