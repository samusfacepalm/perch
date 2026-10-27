import { test } from "node:test";
import assert from "node:assert/strict";
import { tailLines } from "../src/ui/App.js";

test("a short reply streams in full", () => {
  assert.equal(tailLines("one\ntwo", 80, 10), "one\ntwo");
});

test("a long reply shows only its last screenful, counting wrapped lines", () => {
  const text = ["a", "b", "x".repeat(25), "c"].join("\n");
  // at width 10 the long line takes 3 rows, so 4 rows hold it and "c" but not "b"
  assert.equal(tailLines(text, 10, 4), "…\n" + "x".repeat(25) + "\nc");
});
