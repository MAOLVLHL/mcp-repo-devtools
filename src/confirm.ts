/**
 * Human approval before a GitHub write.
 *
 * Elicitation is the way the protocol asks the person at the other end of the
 * connection, and it is a client capability: a host without it cannot reach a
 * human at all. This module therefore has two modes. By default a write asks
 * when it can, and proceeds as before when it cannot, so an existing host sees
 * no change. With requireConfirmation a write that cannot ask is refused,
 * which is the setting to use when the server runs unattended.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** What the human is being asked to approve, in their words rather than the API words. */
export interface WriteRequest {
  /** Tool name, e.g. gh_pr_create. */
  tool: string;
  /** Imperative line: "Open a pull request". */
  action: string;
  /** Short target: "acme/widget", "acme/widget#42". */
  target: string;
  /** Extra lines the approver needs, e.g. "head: feat/x -> base: main". */
  details?: string[];
}

export type ApprovalOutcome =
  | { approved: true; via: "elicitation" | "not-asked" }
  | {
      approved: false;
      via: "unsupported" | "declined" | "cancelled" | "failed";
      reason: string;
    };

export interface ApprovalOptions {
  /** Refuse when the client cannot ask a human, instead of proceeding. */
  requireConfirmation?: boolean;
  /** The tool call cancellation signal, so a cancelled call stops waiting. */
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** A person may take minutes; an absent one must not hang the call forever. */
export const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

/** Longest note kept from the approver, so a paste cannot inflate the result. */
const MAX_NOTE_CHARS = 500;

export function clientCanElicit(server: McpServer): boolean {
  return server.server.getClientCapabilities()?.elicitation !== undefined;
}

/** The question shown to the human: what will happen, to what, and to which branch. */
export function approvalMessage(request: WriteRequest): string {
  const lines = ["Approve this GitHub write?", "", "  " + request.action, "  " + request.target];
  for (const detail of request.details ?? []) {
    if (detail.length > 0) {
      lines.push("  " + detail);
    }
  }
  return lines.join("\n");
}

function noteOf(content: unknown): string | null {
  if (content === null || typeof content !== "object") {
    return null;
  }
  const note = (content as { note?: unknown }).note;
  if (typeof note !== "string" || note.trim().length === 0) {
    return null;
  }
  return note.trim().slice(0, MAX_NOTE_CHARS);
}

/**
 * Ask the human, and fail closed on anything that is not a clear yes: a
 * cancelled prompt, a dropped connection and a timeout all mean "not sent".
 */
export async function requestWriteApproval(
  server: McpServer,
  request: WriteRequest,
  options: ApprovalOptions = {},
): Promise<ApprovalOutcome> {
  if (!clientCanElicit(server)) {
    if (options.requireConfirmation) {
      return {
        approved: false,
        via: "unsupported",
        reason:
          "the client cannot ask a human (it does not advertise elicitation) and this server requires " +
          "confirmation for " + request.tool + "; nothing was sent",
      };
    }
    return { approved: true, via: "not-asked" };
  }

  try {
    const result = await server.server.elicitInput(
      {
        message: approvalMessage(request),
        requestedSchema: {
          type: "object",
          properties: {
            approve: {
              type: "boolean",
              title: "Approve",
              description: request.action + " on " + request.target,
              default: false,
            },
            note: {
              type: "string",
              title: "Note",
              description: "Optional: why, or what to change instead",
              maxLength: MAX_NOTE_CHARS,
            },
          },
          required: ["approve"],
        },
      },
      { signal: options.signal, timeout: options.timeoutMs ?? APPROVAL_TIMEOUT_MS },
    );

    const content = result.content as { approve?: unknown; note?: unknown } | undefined;
    const note = noteOf(content);
    if (result.action === "accept" && content?.approve === true) {
      return { approved: true, via: "elicitation" };
    }
    if (result.action === "cancel") {
      return { approved: false, via: "cancelled", reason: "cancelled by the user; nothing was sent" };
    }
    return {
      approved: false,
      via: "declined",
      reason: note ? "declined by the user: " + note : "declined by the user; nothing was sent",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      approved: false,
      via: "failed",
      reason: "approval could not be obtained (" + message + "); nothing was sent",
    };
  }
}
