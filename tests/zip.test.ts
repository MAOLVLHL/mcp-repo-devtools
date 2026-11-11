import assert from "node:assert/strict";
import test from "node:test";
import { readZipEntries } from "../src/zip.js";
import { makeZip } from "./zipfixture.js";

test("readZipEntries inflates deflated and stored entries in archive order", () => {
  const archive = makeZip([
    { name: "1_setup.txt", content: "setup ok\n" },
    { name: "3_test.txt", content: "line one\nAssertionError: boom\n", store: true },
  ]);

  const entries = readZipEntries(archive);
  assert.deepEqual(
    entries.map((entry) => entry.name),
    ["1_setup.txt", "3_test.txt"],
  );
  assert.match(entries[1]?.text ?? "", /AssertionError: boom/);
});

test("readZipEntries returns nothing for data that is not a zip", () => {
  assert.deepEqual(readZipEntries(Buffer.from("<!doctype html><html>nope</html>")), []);
  assert.deepEqual(readZipEntries(Buffer.alloc(0)), []);
});

test("readZipEntries skips a truncated archive instead of throwing", () => {
  const archive = makeZip([{ name: "1.txt", content: "hello" }]);
  const truncated = archive.subarray(0, archive.length - 8);
  assert.doesNotThrow(() => readZipEntries(truncated));
});
