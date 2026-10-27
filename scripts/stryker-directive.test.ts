import { describe, expect, test } from "vitest";
import { directiveProblem, markDisables, markedDisables } from "./stryker-directive.ts";

describe("directiveProblem", () => {
  test.each([
    " Stryker disable next-line StringLiteral: 1 survivor: the message is never shown",
    " Stryker disable next-line StringLiteral, BlockStatement: 2 survivors: both are equivalent here",
    " Stryker disable next-line StringLiteral: 12 survivors: more than one digit",
    " a comment that mentions Stryker disable in passing",
    " Stryker said so",
  ])("accepts %j", (text) => {
    expect(directiveProblem(text)).toBeUndefined();
  });

  test.each([
    " Stryker disable StringLiteral: 1 survivor: a file-wide disable",
    " Stryker disable next-line StringLiteral",
    " Stryker disable next-line StringLiteral:",
    " Stryker disable next-line StringLiteral:   ",
    " Stryker disable next-line StringLiteral: the reason alone, with no survivor count",
    " Stryker disable next-line StringLiteral: 0 survivors: a disable that expects nothing",
    " Stryker disable next-line StringLiteral: 01 survivor: a leading zero",
    " Stryker disable next-line StringLiteral: x1 survivor: junk before the count",
    " Stryker disable next-line StringLiteral: 1 survived: not the word",
    " Stryker disable next-line StringLiteral: 1 survivor",
    " Stryker disable next-line StringLiteral: 1 survivor:",
    " Stryker disable next-line StringLiteral: 1 survivor:   ",
    " Stryker restore StringLiteral",
    "Stryker disable next-line StringLiteral: 1 survivor: no space after the slashes",
    " Stryker disable next-line StringLiteral,BlockStatement: 1 survivor: no space after the comma",
    "Stryker disable all, then Stryker disable next-line StringLiteral: 1 survivor: the allowed form, too late",
  ])("rejects %j", (text) => {
    expect(directiveProblem(text)).toMatch(
      /`\/\/ Stryker disable next-line <Mutator>: <N> survivors: <reason>`/u,
    );
  });

  test("rejects the all wildcard, in any case", () => {
    expect(directiveProblem(" Stryker disable next-line All: 1 survivor: everything")).toMatch(
      /rather than all/u,
    );
    expect(
      directiveProblem(" Stryker disable next-line StringLiteral, all: 1 survivor: x"),
    ).toMatch(/all/u);
  });
});

describe("markDisables", () => {
  test("swaps each indented disable for a marker on the same line", () => {
    const source = [
      "// Stryker disable next-line StringLiteral: 1 survivor: a",
      "f('x');",
      "\t  // Stryker disable next-line BlockStatement: 2 survivors: b",
      "g();",
    ].join("\n");
    expect(markDisables(source)).toBe(
      [
        "// Stryker expect next-line StringLiteral: 1 survivor: a",
        "f('x');",
        "\t  // Stryker expect next-line BlockStatement: 2 survivors: b",
        "g();",
      ].join("\n"),
    );
  });

  test("leaves a disable that doesn't start its line", () => {
    const source = 'const text = "// Stryker disable next-line StringLiteral: 1 survivor: a";';
    expect(markDisables(source)).toBe(source);
  });
});

describe("markedDisables", () => {
  test("lists each marker with its line, mutators, and expected survivors", () => {
    const source = [
      "f();",
      "  // Stryker expect next-line StringLiteral, BlockStatement: 3 survivors: a",
      "g('x');",
      "// Stryker expect next-line ArrayDeclaration: 12 survivors: b",
      "h();",
      "// Stryker disable next-line ArrayDeclaration: 1 survivor: unmarked",
      'const text = "// Stryker expect next-line ArrayDeclaration: 1 survivor: in a string";',
    ].join("\n");
    expect(markedDisables(source)).toEqual([
      { line: 2, mutators: ["StringLiteral", "BlockStatement"], expected: 3 },
      { line: 4, mutators: ["ArrayDeclaration"], expected: 12 },
    ]);
  });

  test("skips a marker that states no survivor count", () => {
    const source = "// Stryker expect next-line StringLiteral: the old form\nf('x');";
    expect(markedDisables(source)).toEqual([]);
  });
});
