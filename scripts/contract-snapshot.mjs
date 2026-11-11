#!/usr/bin/env node
/**
 * Rewrites tests/fixtures/tool-surface.json from the current registration.
 * Run it deliberately: the diff is the review record for a surface change.
 *
 *   node --import tsx scripts/contract-snapshot.mjs
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.ts";

const root = await mkdtemp(join(tmpdir(), "repo-devtools-snapshot-"));
const server = createServer({ allowedRoots: [root], token: null, enableWrite: false });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
const client = new Client({ name: "snapshot", version: "0.0.0" }, { capabilities: {} });
await client.connect(clientTransport);
const { tools } = await client.listTools();
await client.close();

const ANNOTATION_FIELDS = ["destructiveHint", "idempotentHint", "openWorldHint", "readOnlyHint"];

const shape = tools
  .map((tool) => {
    const schema = (tool.inputSchema ?? {});
    const annotations = tool.annotations ?? {};
    return {
      name: tool.name,
      properties: Object.keys(schema.properties ?? {}).sort(),
      required: [...(schema.required ?? [])].sort(),
      annotations: Object.fromEntries(
        ANNOTATION_FIELDS.map((field) => [field, annotations[field] ?? null]),
      ),
    };
  })
  .sort((left, right) => left.name.localeCompare(right.name));

const out = new URL("../tests/fixtures/tool-surface.json", import.meta.url);
await writeFile(out, JSON.stringify(shape, null, 2) + "\n");
console.log("wrote " + out.pathname + " (" + String(shape.length) + " tools)");
