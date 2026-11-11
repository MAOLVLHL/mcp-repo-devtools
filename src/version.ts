/**
 * The one copy of the version. Read from package.json rather than a literal: a
 * second copy drifts the first time someone forgets to bump both, and the
 * User-Agent GitHub records is the copy that drifts silently.
 */

import { readFileSync } from "node:fs";

const PACKAGE = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

export const VERSION: string = PACKAGE.version;
export const SERVER_NAME = "mcp-repo-devtools";

/** What GitHub sees on every request. A stale version here is invisible until someone looks. */
export const USER_AGENT = SERVER_NAME + "/" + VERSION;
