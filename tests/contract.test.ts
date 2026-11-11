import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "../src/server.js";

/** Fields a host can read out of a tool annotation. Hints, not permissions. */
const ANNOTATION_FIELDS = ["destructiveHint", "idempotentHint", "openWorldHint", "readOnlyHint"] as const;

async function withClient<T>(enableWrite: boolean, run: (client: Client) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "repo-devtools-contract-"));
  const server = createServer({ allowedRoots: [root], token: null, enableWrite });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "contract", version: "0.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  try {
    return await run(client);
  } finally {
    await client.close();
  }
}

/** The shape a host sees, independent of descriptions and ordering. */
async function surface(enableWrite: boolean) {
  return withClient(enableWrite, async (client) => {
    const { tools } = await client.listTools();
    return tools
      .map((tool) => {
        const schema = (tool.inputSchema ?? {}) as {
          properties?: Record<string, unknown>;
          required?: string[];
        };
        const output = (tool.outputSchema ?? {}) as { properties?: Record<string, unknown> };
        const annotations = (tool.annotations ?? {}) as Record<string, boolean | undefined>;
        return {
          name: tool.name,
          properties: Object.keys(schema.properties ?? {}).sort(),
          required: [...(schema.required ?? [])].sort(),
          annotations: Object.fromEntries(
            ANNOTATION_FIELDS.map((field) => [field, annotations[field] ?? null]),
          ),
          output: Object.keys(output.properties ?? {}).sort(),
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name));
  });
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

test("every tool says whether it reads or writes, and whether it is safe to repeat", async () => {
  const localTools = ["git_status", "git_log", "git_diff"];
  const writeTools = ["gh_pr_create", "gh_issue_create", "gh_pr_comment"];
  const readOnlyTools = [
    "git_status",
    "git_log",
    "git_diff",
    "gh_issue_search",
    "gh_ci_failures",
    "gh_pr_context",
  ];

  const seen = new Set<string>();
  for (const tool of [...(await surface(false)), ...(await surface(true))]) {
    seen.add(tool.name);
    const destructive = writeTools.includes(tool.name);
    const openWorld = !localTools.includes(tool.name);
    assert.equal(tool.annotations["readOnlyHint"], !destructive, tool.name + " readOnlyHint");
    assert.equal(tool.annotations["destructiveHint"], destructive, tool.name + " destructiveHint");
    assert.equal(tool.annotations["idempotentHint"], !destructive, tool.name + " idempotentHint");
    assert.equal(tool.annotations["openWorldHint"], openWorld, tool.name + " openWorldHint");
  }
  assert.deepEqual([...seen].sort(), [...readOnlyTools, ...writeTools].sort());
});

test("the server explains how to start and what write mode means", async () => {
  const instructions = await withClient(false, async (client) => client.getInstructions());
  assert.ok(instructions && instructions.length > 100, "instructions are sent at initialize");
  assert.match(instructions, /git_status/);
  assert.match(instructions, /MCP_ENABLE_WRITE=1/);
});
