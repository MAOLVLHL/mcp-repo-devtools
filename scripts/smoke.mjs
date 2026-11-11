#!/usr/bin/env node
/**
 * Manual smoke test: start the built server over stdio and call the git tools
 * against a real repository. Requires `npm run build` first.
 *
 *   node scripts/smoke.mjs /path/to/repo [owner/name]
 */

import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repo = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
const slug = process.argv[3];

const env = { MCP_ALLOWED_ROOTS: path.dirname(repo) };
for (const key of ["PATH", "HOME", "USERPROFILE", "SystemRoot", "TMP", "TEMP", "GITHUB_TOKEN"]) {
  if (process.env[key]) {
    env[key] = process.env[key];
  }
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.resolve("dist/index.js")],
  env,
  stderr: "inherit",
});
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log("tools:", tools.map((tool) => tool.name).join(", "));

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content ?? []).map((part) => part.text ?? "").join("");
  console.log("\n=== " + name + " " + JSON.stringify(args) + " ===");
  console.log(text.slice(0, 1200));
}

await call("git_status", { repo });
await call("git_log", { repo, limit: 5 });
await call("git_diff", { repo, mode: "stat" });
if (slug) {
  await call("gh_issue_search", { repo: slug, query: "", state: "open", limit: 3 });
}

await client.close();
