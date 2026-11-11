#!/usr/bin/env node
/**
 * Route A demo, offline: three prompts, a declined write, a summarised diff.
 *
 * Runs the real server over an in-memory transport with a client that declares
 * elicitation and sampling, so every hop is the production code path.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CreateMessageRequestSchema, ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { createServer } from "../dist/server.js";

const dir = mkdtempSync(join(tmpdir(), "route-a-demo-"));
const git = (...args) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
const body = (marker) =>
  Array.from({ length: 3000 }, (_, i) => marker + " line " + i + " of a long file").join("\n") + "\n";

execFileSync("git", ["init", "-b", "main", dir], { stdio: "pipe" });
git("config", "user.email", "demo@example.com");
git("config", "user.name", "demo");
git("config", "commit.gpgsign", "false");
writeFileSync(join(dir, "big.txt"), body("before"));
git("add", "-A");
git("commit", "-m", "init");
writeFileSync(join(dir, "big.txt"), body("after"));

const server = createServer({
  allowedRoots: [dir],
  enableWrite: true,
  token: "ghp_demo",
  compressOutput: true,
});
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client(
  { name: "route-a-demo", version: "1.0.0" },
  { capabilities: { elicitation: {}, sampling: {} } },
);
await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

client.setRequestHandler(ElicitRequestSchema, async (request) => {
  console.log("--- the client was asked ---");
  console.log(request.params.message);
  console.log("--- and the human said no ---");
  return { action: "decline", content: { approve: false, note: "not this week" } };
});

client.setRequestHandler(CreateMessageRequestSchema, async (request) => {
  const text = request.params.messages[0]?.content?.text ?? "";
  console.log("--- sampling asked for a summary of " + text.length + " chars ---");
  return {
    model: "demo-summariser",
    role: "assistant",
    content: { type: "text", text: "The diff renames before to after across 3000 lines; list: big.txt" },
  };
});

const prompts = await client.listPrompts();
console.log("\nprompts: " + prompts.prompts.map((p) => p.name).join(", "));
const plan = await client.getPrompt({ name: "diagnose-ci", arguments: { repo: "acme/widget", ref: "main" } });
console.log("\ndiagnose-ci plan (first 4 lines):");
for (const line of (plan.messages[0].content.text ?? "").split("\n").slice(0, 4)) {
  console.log("  " + line);
}

console.log("\nwrite attempt:");
const refused = await client.callTool({
  name: "gh_issue_create",
  arguments: { repo: "acme/widget", title: "A bug that should be filed" },
});
console.log("  isError=" + refused.isError + " -> " + refused.content[0].text);

const diff = await client.callTool({ name: "git_diff", arguments: { repo: dir, mode: "patch" } });
const text = diff.content[0].text;
console.log("\nover-budget diff:");
console.log("  " + text.split("\n")[0]);
console.log("  result bytes=" + Buffer.byteLength(text, "utf8") + " (budget 65536)");

await client.close();
await server.close();
rmSync(dir, { recursive: true, force: true });
