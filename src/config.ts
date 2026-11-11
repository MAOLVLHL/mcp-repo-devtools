/**
 * Repository roots. Every tool that touches the filesystem resolves the path
 * it was given and refuses anything outside MCP_ALLOWED_ROOTS.
 */

import { realpathSync, statSync } from "node:fs";
import path from "node:path";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Split a MCP_ALLOWED_ROOTS value using the platform path separator. */
export function parseAllowedRoots(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Resolve `repo` to a canonical directory and assert it lives under one of
 * `roots`. Symlinks are followed before the comparison so a link cannot be
 * used to escape the allowed tree.
 */
export function assertAllowedRepo(repo: string, roots: string[]): string {
  if (roots.length === 0) {
    throw new ConfigError(
      "MCP_ALLOWED_ROOTS is not set. Set it to the directories this server may read, e.g. MCP_ALLOWED_ROOTS=/home/you/code.",
    );
  }

  let real: string;
  try {
    real = realpathSync.native(path.resolve(repo));
  } catch {
    throw new ConfigError("repository path does not exist: " + path.resolve(repo));
  }

  let isDirectory = false;
  try {
    isDirectory = statSync(real).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) {
    throw new ConfigError("repository path is not a directory: " + real);
  }

  for (const root of roots) {
    let realRoot: string;
    try {
      realRoot = realpathSync.native(path.resolve(root));
    } catch {
      continue;
    }
    if (path.parse(realRoot).root === realRoot) {
      throw new ConfigError(
        "refusing to use a filesystem root as MCP_ALLOWED_ROOTS: " + realRoot,
      );
    }
    const relative = path.relative(realRoot, real);
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      return real;
    }
  }

  throw new ConfigError(
    "repository " + real + " is outside MCP_ALLOWED_ROOTS (" + roots.join(path.delimiter) + ")",
  );
}
