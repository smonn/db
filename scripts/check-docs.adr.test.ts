import { describe, expect, test } from "vitest";
import { checkAdrBody, checkAdrNumbers } from "./check-docs.ts";

const file = "docs/adr/0001-x.md";
const tooLong = (line: number) => [
  { file, line, message: "ADR body has 4 sentences; the template allows 3" },
];

describe("checkAdrBody shapes", () => {
  test("flags a file with no title", () => {
    expect(checkAdrBody(file, "No heading.\nText.\n")).toEqual([
      { file, line: 1, message: "ADR has no title" },
    ]);
  });

  test("looks for the first section only after the title", () => {
    expect(checkAdrBody(file, "## Early\n# Title\n\nOne. Two. Three. Four.\n")).toEqual(tooLong(2));
  });

  test("counts the last line when no section follows the body", () => {
    expect(checkAdrBody(file, "# Title\n\nOne. Two. Three. Four.")).toEqual(tooLong(1));
  });

  test("reads a code span as one word, whatever it holds", () => {
    expect(checkAdrBody(file, "# Title\n\nOne `a. b`. Two. Three.\n")).toEqual([]);
  });

  test("counts a body that ends in a code span", () => {
    expect(checkAdrBody(file, "# Title\n\nOne. Two. Three.\n\n`x`")).toEqual(tooLong(1));
  });

  test("ignores blank lines between the body and the first section", () => {
    expect(checkAdrBody(file, "# Title\n\nOne. Two. Three.\n\n\n## Options\n")).toEqual([]);
  });
});

describe("checkAdrNumbers paths", () => {
  test("reads only paths that start with docs/adr/", () => {
    expect(checkAdrNumbers(["x/docs/adr/0011-a.md", "x/docs/adr/0011-b.md"])).toEqual([]);
  });
});
