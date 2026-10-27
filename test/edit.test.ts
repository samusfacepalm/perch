import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEdit, applyEdits } from "../src/tools/edit.js";

const file = `function add(a, b) {
    const sum = a + b;
    return sum;
}

function sub(a, b) {
    return a - b;
}
`;

test("exact match", () => {
  const { result, matcher } = applyEdit(file, "return a - b;", "return b - a;");
  assert.equal(matcher, "exact");
  assert.match(result, /return b - a;/);
});

test("wrong indentation still matches one place", () => {
  const { result, matcher } = applyEdit(file, "const sum = a + b;\nreturn sum;", "return a + b;");
  assert.equal(matcher, "line-trimmed");
  assert.ok(!result.includes("const sum"));
});

test("misremembered middle line matches by anchors", () => {
  const old = "function add(a, b) {\n    const total = a + b;\n    return sum;\n}";
  const { matcher } = applyEdit(file, old, "function add(a, b) { return a + b; }");
  assert.equal(matcher, "block-anchor");
});

test("ambiguous match is refused", () => {
  assert.throws(() => applyEdit(file, "(a, b) {", "(x, y) {"), /more than one place/);
});

test("replace_all changes every occurrence", () => {
  const { result } = applyEdit(file, "(a, b)", "(x, y)", true);
  assert.equal(result.split("(x, y)").length - 1, 2);
});

test("missing text is refused", () => {
  assert.throws(() => applyEdit(file, "nothing like this", "x"), /not found/);
});

test("several edits in one call, matched against the original", () => {
  const { result } = applyEdits(file, [
    { old_string: "return a - b;", new_string: "return b - a;" },
    { old_string: "const sum = a + b;", new_string: "const sum = b + a;" },
  ]);
  assert.match(result, /const sum = b \+ a;/);
  assert.match(result, /return b - a;/);
});

test("one failing edit leaves the file unchanged and names the edit", () => {
  assert.throws(
    () => applyEdits(file, [{ old_string: "return sum;", new_string: "return 0;" }, { old_string: "nothing like this", new_string: "x" }]),
    /edits\[1\]: old_string was not found.*No edits were made/,
  );
});

test("overlapping edits are refused", () => {
  assert.throws(
    () => applyEdits(file, [{ old_string: "const sum = a + b;\n    return sum;", new_string: "return a + b;" }, { old_string: "return sum;", new_string: "return 0;" }]),
    /edits\[0\] and edits\[1\] overlap/,
  );
});
