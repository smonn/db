import { describe, expect, test } from "vitest";
import { readWorkflow } from "./workflow-yaml.ts";
import type { WorkflowLine } from "./workflow-permissions.ts";

const read = (text: string) => readWorkflow(text, "w.yml");
const line = (
  number: number,
  indent: number,
  value: string,
  key?: WorkflowLine["key"],
): WorkflowLine => ({ number, indent, value, flowKeys: [], ...(key === undefined ? {} : { key }) });
const anchor = (n: number): string =>
  `w.yml line ${n} uses an anchor (&), which this check can't read`;

describe("readWorkflow lines", () => {
  test("reads a plain key and its value without a trailing comment", () => {
    expect(read("a: b  \nc:  d # e # f\n  g: h\n").lines).toEqual([
      line(1, 0, "b", { name: "a", column: 0 }),
      line(2, 0, "d", { name: "c", column: 0 }),
      line(3, 2, "h", { name: "g", column: 2 }),
    ]);
  });

  test("reads no value after a key that ends the line", () => {
    expect(read("a:\nb: # c\n").lines).toEqual([
      line(1, 0, "", { name: "a", column: 0 }),
      line(2, 0, "", { name: "b", column: 0 }),
    ]);
  });

  test("reads quoted keys by their text", () => {
    expect(read("\"a b\": c\n'd': e\n  'f' : g\n").lines).toEqual([
      line(1, 0, "c", { name: "a b", column: 0 }),
      line(2, 0, "e", { name: "d", column: 0 }),
      line(3, 2, "g", { name: "f", column: 2 }),
    ]);
  });

  test("reads a quoted scalar without a colon as a value", () => {
    expect(read("- \"a\"\n- 'b'\n").lines).toEqual([line(1, 0, '"a"'), line(2, 0, "'b'")]);
  });

  test("reads a flow collection at the start of a line as a value", () => {
    expect(read("[a, b: c]\n{d: e}\n").lines).toEqual([
      { ...line(1, 0, "[a, b: c]"), flowKeys: ["b"] },
      { ...line(2, 0, "{d: e}"), flowKeys: ["d"] },
    ]);
  });

  test("reads no key before a hash", () => {
    expect(read("a#b: c\n").lines).toEqual([line(1, 0, "a#b: c")]);
  });

  test("reads a key after each dash", () => {
    expect(read("- a: b\n  - - c: d\n").lines).toEqual([
      line(1, 0, "b", { name: "a", column: 2 }),
      line(2, 2, "d", { name: "c", column: 6 }),
    ]);
  });

  test("reads a dash with nothing after it as an empty line", () => {
    expect(read("-\n  - # c\n").lines).toEqual([line(1, 0, ""), line(2, 2, "")]);
  });

  test("reads a word that starts with a dash as a value", () => {
    expect(read("-a: b\n- -c\n").lines).toEqual([
      line(1, 0, "b", { name: "-a", column: 0 }),
      line(2, 0, "-c"),
    ]);
  });

  test("reads the flow keys of a value", () => {
    expect(read("a: {b: [c, {d}]}\n").lines).toEqual([
      { ...line(1, 0, "{b: [c, {d}]}", { name: "a", column: 0 }), flowKeys: ["b", "d"] },
    ]);
  });

  test("keeps document-marker lookalikes", () => {
    expect(read("---x: y\nrun: wait...\nwidth: 100%\n...x: z\n").problems).toEqual([]);
  });

  test("skips blank and comment lines", () => {
    expect(read("\n  \n# a\n  # b\nc: d\n").lines).toEqual([
      line(5, 0, "d", { name: "c", column: 0 }),
    ]);
  });
});

describe("readWorkflow block scalars", () => {
  test.each([
    ["a header with a trailing comment", "a: | # a long comment\n  b\n"],
    ["a keep indicator and indent digit", "a: >+2\n  b\n"],
  ])("accepts %s", (_name, text) => {
    expect(read(text).problems).toEqual([]);
  });

  test("refuses text before a closing indicator in the header", () => {
    expect(read("a: |x |\n").problems).toEqual([
      "w.yml line 1 uses a block scalar header, which this check can't read",
    ]);
  });

  test("ends the scalar at the key's own column", () => {
    expect(read("a:\n  b: |\n    c\n  d: &e f\n").problems).toEqual([anchor(4)]);
  });

  test("ends the scalar at a line with the indent of a keyless header", () => {
    expect(read("  |\n   &a b\n  &c d\n").problems).toEqual([anchor(3)]);
  });

  test("ends the scalar at the column of the last dash", () => {
    expect(read("- - |\n    &a b\n  &c d\n").problems).toEqual([anchor(3)]);
  });

  test("ends a top-level keyless scalar at an unindented line", () => {
    expect(read("|\n &a b\n&c d\n").problems).toEqual([anchor(3)]);
  });

  test("keeps a blank line that is no deeper than the owner inside the scalar", () => {
    expect(read("  a: |\n  \n    &b c\n").problems).toEqual([]);
    expect(read("a: |\n\n  &b c\n").problems).toEqual([]);
  });

  test("keeps a comment-like line inside the scalar", () => {
    expect(read("a: |\n  # b\n  &c d\n").problems).toEqual([]);
  });

  test("ends the scalar at a comment line that is no deeper than the owner", () => {
    expect(read("a: |\n  b\n# c\n  &d e\n").problems).toEqual([anchor(4)]);
  });

  test("does not open a scalar for a plain value", () => {
    expect(read("a: b\n  c: &d e\n").problems).toEqual([anchor(2)]);
  });
});
