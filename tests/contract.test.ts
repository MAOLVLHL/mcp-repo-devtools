import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "../src/server.js";

/** The shape a host sees, independent of descriptions and ordering. */
async function surface(enableWrite: boolean) {
  const root = await mkdtemp(join(tmpdir(), "repo-devtools-contract-"));
  const server = createServer({ allowedRoots: [root], token: null, enableWrite });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "contract", version: "0.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  await client.close();

  const shape = tools
    .map((tool) => {
      const schema = (tool.inputSchema ?? {}) as {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      return {
        name: tool.name,
        properties: Object.keys(schema.properties ?? {}).sort(),
        required: [...(schema.required ?? [])].sort(),
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
