import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { assertAllowedRepo, ConfigError, parseAllowedRoots } from "../src/config.js";

function workspace(): string {
  return mkdtempSync(path.join(tmpdir(), "repo-devtools-config-"));
}

test("parseAllowedRoots splits on the platform separator and trims", () => {
  const roots = parseAllowedRoots([" /a ", "/b", "", "/c "].join(path.delimiter));
  assert.deepEqual(roots, ["/a", "/b", "/c"]);
});

test("parseAllowedRoots returns nothing for an unset value", () => {
  assert.deepEqual(parseAllowedRoots(undefined), []);
  assert.deepEqual(parseAllowedRoots("   "), []);
});

test("assertAllowedRepo refuses to work without roots", () => {
  assert.throws(() => assertAllowedRepo(process.cwd(), []), ConfigError);
});

test("assertAllowedRepo accepts a repository below a root", () => {
  const base = workspace();
  try {
    const repo = path.join(base, "project");
    mkdirSync(repo);
    assert.equal(assertAllowedRepo(repo, [base]), realpathSync.native(repo));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("assertAllowedRepo rejects a sibling with a shared prefix", () => {
  const base = workspace();
  try {
    const root = path.join(base, "code");
    const sibling = path.join(base, "code-other");
    mkdirSync(root);
    mkdirSync(sibling);
    assert.throws(() => assertAllowedRepo(sibling, [root]), /outside MCP_ALLOWED_ROOTS/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("assertAllowedRepo rejects the parent of a root", () => {
  const base = workspace();
  try {
    const root = path.join(base, "code");
    mkdirSync(root);
    assert.throws(() => assertAllowedRepo(base, [root]), /outside MCP_ALLOWED_ROOTS/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("assertAllowedRepo rejects a missing path", () => {
  const base = workspace();
  try {
    assert.throws(() => assertAllowedRepo(path.join(base, "nope"), [base]), /does not exist/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("assertAllowedRepo refuses a filesystem root as the allowed root", () => {
  if (process.platform !== "win32") {
    return;
  }
  assert.throws(() => assertAllowedRepo(process.cwd(), ["C:\\"]), /filesystem root/);
});
