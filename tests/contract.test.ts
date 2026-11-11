import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "../src/server.js";

const ANNOTATION_FIELDS = ["destructiveHint", "idempotentHint", "openWorldHint", "readOnlyHint"] as const;

/** Connect once and keep both halves of the handshake: the tool list and the instructions. */
async function handshake(enableWrite: boolean) {
  const root = await mkdtemp(join(tmpdir(), "repo-devtools-contract-"));
  const server = createServer({ allowedRoots: [root], token: null, enableWrite });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "contract", version: "0.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  const instructions = client.getInstructions();
  await client.close();
  return { tools, instructions };
}

/** The shape a host sees, independent of descriptions and ordering. */
async function surface(enableWrite: boolean) {
  const { tools } = await handshake(enableWrite);
  const shape = tools
    .map((tool) => {
      const schema = (tool.inputSchema ?? {}) as {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      const annotations = (tool.annotations ?? {}) as Record<string, boolean | undefined>;
      return {
        name: tool.name,
        properties: Object.keys(schema.properties ?? {}).sort(),
        required: [...(schema.required ?? [])].sort(),
        // A hint that disappears changes behaviour for the host, so a missing
        // one is recorded as null rather than omitted.
        annotations: Object.fromEntries(
          ANNOTATION_FIELDS.map((field) => [field, annotations[field] ?? null]),
        ),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  return shape;
}

test("the default tool surface does not change by accident", async () => {
  const expected = JSON.parse(
    readFileSync(new URL("./fixtures/tool-surface.json", import.meta.url), "utf8"),
  ) as unknown;
  assert.deepEqual(await surface(false), expected);
});

test("write tools appear only when write mode is on", async () => {
  const readOnly = (await surface(false)).map((tool) => tool.name);
  const writable = (await surface(true)).map((tool) => tool.name);

  for (const name of ["gh_pr_create", "gh_issue_create", "gh_pr_comment"]) {
    assert.equal(readOnly.includes(name), false, name + " must not exist by default");
    assert.equal(writable.includes(name), true, name + " must exist in write mode");
  }
  assert.equal(writable.length, readOnly.length + 3);
});

test("every tool says what it does to the world", async () => {
  const tools = await surface(true);
  const byName = new Map(tools.map((tool) => [tool.name, tool.annotations]));

  for (const name of ["git_status", "git_log", "git_diff"]) {
    assert.deepEqual(byName.get(name), {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  }
  for (const name of ["gh_issue_search", "gh_ci_failures", "gh_pr_context"]) {
    assert.deepEqual(byName.get(name), {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
  }
  for (const name of ["gh_pr_create", "gh_issue_create", "gh_pr_comment"]) {
    assert.deepEqual(byName.get(name), {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
  }
});

test("the server explains itself once, at connect time", async () => {
  const { instructions } = await handshake(false);
  assert.equal(typeof instructions, "string");
  // The two facts a host cannot infer from a tool list.
  assert.match(instructions ?? "", /git_status/);
  assert.match(instructions ?? "", /MCP_ENABLE_WRITE=1/);
});
