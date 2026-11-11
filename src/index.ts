#!/usr/bin/env node
/**
 * stdio entry point. stdout carries the MCP protocol and nothing else;
 * diagnostics go to stderr.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseAllowedRoots } from "./config.js";
import { createServer, parseEnableWrite, SERVER_NAME, VERSION } from "./server.js";

const argv = process.argv.slice(2);

if (argv.includes("--version") || argv.includes("-v")) {
  process.stdout.write(VERSION + "\n");
  process.exit(0);
}

if (argv.includes("--help") || argv.includes("-h")) {
  process.stdout.write(
    [
      SERVER_NAME + " " + VERSION,
      "",
      "A coding agent's tool surface: git history, GitHub issues, CI failures, pull requests.",
      "Read-only unless MCP_ENABLE_WRITE=1. Three prompts, progress and cancellation, and a",
      "reference agent loop ship with it; see the README for what a host can turn on.",
      "",
      "Usage: mcp-repo-devtools            start the stdio server",
      "       mcp-repo-devtools --version",
      "",
      "Environment:",
      "  MCP_ALLOWED_ROOTS         required; directories this server may read (path-separated)",
      "  GITHUB_TOKEN              optional; raises the GitHub API limit from 60 to 5000/hour",
      "  MCP_ENABLE_WRITE          optional; set to 1 to also register the write tools",
      "  MCP_CONFIRM_WRITES        optional; unset asks when the client can, 1 fails closed, 0 never asks",
      "  MCP_SAMPLING_COMPRESSION  optional; set to 1 to let the client summarise over-budget results",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

const roots = parseAllowedRoots(process.env["MCP_ALLOWED_ROOTS"]);
if (roots.length === 0) {
  process.stderr.write(
    "[" + SERVER_NAME + "] MCP_ALLOWED_ROOTS is not set; every repository call will be rejected.\n",
  );
}

const writeEnabled = parseEnableWrite(process.env["MCP_ENABLE_WRITE"]);
const server = createServer({ allowedRoots: roots, enableWrite: writeEnabled });
await server.connect(new StdioServerTransport());
process.stderr.write(
  "[" + SERVER_NAME + "] ready (roots: " + (roots.join(", ") || "none") + ", write: " + (writeEnabled ? "on" : "off") + ")\n",
);
