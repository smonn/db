import { describe, expect, test } from "vitest";
import { directiveProblem, markDisables, markedDisables } from "./stryker-directive.ts";

describe("directiveProblem", () => {
  test.each([
    " Stryker disable next-line StringLiteral: the message is never shown",
    " Stryker disable next-line StringLiteral, BlockStatement: both are equivalent here",
    " a comment that mentions Stryker disable in passing",
    " Stryker said so",
  ])("accepts %j", (text) => {
    expect(directiveProblem(text)).toBeUndefined();
  });

  test.each([
    " Stryker disable StringLiteral: a file-wide disable",
    " Stryker disable next-line StringLiteral",
    " Stryker disable next-line StringLiteral:",
    " Stryker disable next-line StringLiteral:   ",
    " Stryker restore StringLiteral",
    "Stryker disable next-line StringLiteral: no space after the slashes",
    " Stryker disable next-line StringLiteral,BlockStatement: no space after the comma",
    "Stryker disable all, then Stryker disable next-line StringLiteral: the allowed form, too late",
  ])("rejects %j", (text) => {
    expect(directiveProblem(text)).toMatch(/`\/\/ Stryker disable next-line <Mutator>: <reason>`/u);
  });

  test("rejects the all wildcard, in any case", () => {
    expect(directiveProblem(" Stryker disable next-line All: everything")).toMatch(
      /rather than all/u,
    );
    expect(directiveProblem(" Stryker disable next-line StringLiteral, all: x")).toMatch(/all/u);
  });
});

describe("markDisables", () => {
  test("swaps each indented disable for a marker on the same line", () => {
    const source = [
      "// Stryker disable next-line StringLiteral: a",
      "f('x');",
      "\t  // Stryker disable next-line BlockStatement: b",
      "g();",
    ].join("\n");
    expect(markDisables(source)).toBe(
      [
        "// Stryker expect next-line StringLiteral: a",
        "f('x');",
        "\t  // Stryker expect next-line BlockStatement: b",
        "g();",
      ].join("\n"),
    );
  });

  test("leaves a disable that doesn't start its line", () => {
    const source = 'const text = "// Stryker disable next-line StringLiteral: a";';
    expect(markDisables(source)).toBe(source);
  });
});

describe("markedDisables", () => {
  test("lists each mutator of each marker with the marker's line", () => {
    const source = [
      "f();",
      "  // Stryker expect next-line StringLiteral, BlockStatement: a",
      "g('x');",
      "// Stryker disable next-line ArrayDeclaration: unmarked",
      'const text = "// Stryker expect next-line ArrayDeclaration: in a string";',
    ].join("\n");
    expect(markedDisables(source)).toEqual([
      { line: 2, mutator: "StringLiteral" },
      { line: 2, mutator: "BlockStatement" },
    ]);
  });
});
