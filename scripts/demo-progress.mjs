#!/usr/bin/env node
/**
 * Manual demo: watch progress notifications arrive while a multi-hop GitHub call
 * runs, then cancel a second call and see the in-flight fetch abort.
 *
 *   npm run build && node scripts/demo-progress.mjs
 *
 * No network and no token: fetch is stubbed with a small delay per hop.
 */

import { deflateRawSync } from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";

function makeZip(name, text) {
  const nameBytes = Buffer.from(name, "utf8");
  const raw = Buffer.from(text, "utf8");
  const payload = deflateRawSync(raw);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(payload.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(local.length + nameBytes.length + payload.length, 42);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + nameBytes.length, 12);
  eocd.writeUInt32LE(local.length + nameBytes.length + payload.length, 16);
  return Buffer.concat([local, nameBytes, payload, central, nameBytes, eocd]);
}

const HOP_DELAY_MS = 250;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const json = (body) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

const failingCheck = (name, runId) => ({
  name,
  status: "completed",
  conclusion: "failure",
  details_url: "https://github.com/acme/widget/actions/runs/" + runId + "/job/1",
  head_sha: "abc123",
  output: { title: name + " failed", summary: "1 failing test" },
});

const routes = [
  [
    /\/commits\/main\/check-runs/,
    () =>
      json({
        total_count: 3,
        check_runs: [failingCheck("test (ubuntu-latest, 20)", 1001), failingCheck("test (windows-latest, 22)", 1002)],
      }),
  ],
  [
    /\/actions\/runs\/(\d+)\/jobs/,
    (url) => json({ jobs: [{ id: 5000 + Number(/runs\/(\d+)/.exec(url)[1]) % 10, name: "test", steps: [{ name: "run tests", conclusion: "failure" }] }] }),
  ],
  [
    /\/actions\/jobs\/(\d+)\/logs/,
    (url) => new Response(null, { status: 302, headers: { location: "https://blob.test/" + /jobs\/(\d+)/.exec(url)[1] } }),
  ],
  [/blob\.test\//, () => new Response(makeZip("1_job.txt", "2026-01-01T00:00:00Z 1 test failed\n"), { status: 200 })],
  [/\/pulls\/7$/, (url, init) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  })],
];

let sawAbort = false;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  init?.signal?.addEventListener("abort", () => {
    sawAbort = true;
  });
  await wait(url.includes("blob.test") ? 0 : HOP_DELAY_MS);
  for (const [pattern, handler] of routes) {
    if (pattern.test(url)) {
      return handler(url, init);
    }
  }
  throw new Error("unexpected fetch: " + url);
};

const server = createServer({ allowedRoots: [process.cwd()], token: "demo-token", enableWrite: false });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
const client = new Client({ name: "demo-progress", version: "0.0.0" });
await client.connect(clientTransport);

const started = Date.now();
const elapsed = () => String(Date.now() - started).padStart(5) + "ms";

console.log("phase 1: gh_ci_failures with a progressToken");
const result = await client.callTool(
  { name: "gh_ci_failures", arguments: { repo: "acme/widget", ref: "main", include_logs: true } },
  undefined,
  {
    onprogress: (progress) => {
      const total = progress.total === undefined ? "?" : String(progress.total);
      console.log("  [" + elapsed() + "] " + String(progress.progress) + "/" + total + "  " + (progress.message ?? ""));
    },
  },
);
const text = (result.content ?? []).map((part) => part.text ?? "").join("");
console.log("  final text, first line: " + text.split("\n")[0]);
console.log("  structuredContent.failures: " + (result.structuredContent?.failures?.length ?? 0));

console.log("\nphase 2: cancel gh_pr_context mid-flight");
const controller = new AbortController();
const call = client.callTool({ name: "gh_pr_context", arguments: { repo: "acme/widget", number: 7 } }, undefined, {
  signal: controller.signal,
});
await wait(200);
console.log("  [" + elapsed() + "] aborting the call");
controller.abort();
try {
  await call;
  console.log("  unexpected: the call resolved");
} catch (error) {
  console.log("  rejected with: " + error.name);
}
await wait(50);
console.log("  in-flight fetch saw the abort: " + sawAbort);

await client.close();
