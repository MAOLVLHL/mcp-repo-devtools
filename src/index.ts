#!/usr/bin/env node
/**
 * stdio entry point. stdout carries the MCP protocol and nothing else;
 * diagnostics go to stderr.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseAllowedRoots } from "./config.js";
import { createServer, SERVER_NAME, VERSION } from "./server.js";

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
      "Read-only MCP server for git history, GitHub issues and CI failures.",
      "",
      "Usage: mcp-repo-devtools            start the stdio server",
      "       mcp-repo-devtools --version",
      "",
      "Environment:",
      "  MCP_ALLOWED_ROOTS  required; directories this server may read (path-separated)",
      "  GITHUB_TOKEN       optional; raises the GitHub API limit from 60 to 5000/hour",
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

const server = createServer({ allowedRoots: roots });
await server.connect(new StdioServerTransport());
process.stderr.write("[" + SERVER_NAME + "] ready (roots: " + (roots.join(", ") || "none") + ")\n");
