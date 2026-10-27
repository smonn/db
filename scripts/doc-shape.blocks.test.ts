import { describe, expect, test } from "vitest";
import { checkBudget } from "./doc-shape.ts";

const dash = String.fromCodePoint(0x2014);
const words = (count: number): string => Array.from({ length: count }, () => "w").join(" ");
const tooLong = (line: number, count: number) => [
  {
    file: "docs/a.md",
    line,
    message: `block has ${count} words; the cap is 120. Split it by topic, move behavior inside one module to its TSDoc, or cut`,
  },
];
const blocksOf = (text: string) => checkBudget("docs/a.md", text, 100_000);

describe("checkBudget blocks", () => {
  test("joins the lines of a paragraph", () => {
    expect(blocksOf(`${words(100)}\n${words(30)}\n`)).toEqual(tooLong(1, 130));
  });

  test("ends a paragraph at a line of spaces", () => {
    expect(blocksOf(`${words(100)}\n   \n${words(30)}\n`)).toEqual([]);
  });

  test.each(["  - ", "* ", "10. ", "1. "])("starts a new block at a %j item", (marker) => {
    expect(blocksOf(`${words(100)}\n${marker}${words(30)}\n`)).toEqual([]);
  });

  test("keeps a line that only looks like a marker inside its paragraph", () => {
    expect(blocksOf(`${words(100)}\n1.5 ${words(29)}\n`)).toEqual(tooLong(1, 130));
    expect(blocksOf(`${words(100)}\nsome - ${words(28)} # and | end\n`)).toEqual(tooLong(1, 131));
  });

  test("keeps a heading, an indented table row, and a pipe in its own block", () => {
    expect(blocksOf(`# ${words(100)}\n${words(30)}\n`)).toEqual([]);
    expect(blocksOf(`  | ${words(100)} |\n${words(30)}\n`)).toEqual([]);
    expect(blocksOf(`a | ${words(100)}\n${words(30)}\n`)).toEqual(tooLong(1, 131));
  });

  test("counts words with letters or digits, not punctuation", () => {
    const text = `Café ${dash} ... 42 | - * naïve\n`;
    expect(checkBudget("docs/a.md", text, 3)).toEqual([]);
    expect(checkBudget("docs/a.md", text, 2)).toEqual([
      {
        file: "docs/a.md",
        line: 1,
        message:
          "3 words; the cap is 2. Move behavior inside one module to its TSDoc, a decision to an ADR, or cut",
      },
    ]);
  });

  test("lets a file or block sit exactly at its cap", () => {
    expect(checkBudget("docs/a.md", words(120), 120)).toEqual([]);
    expect(checkBudget("docs/a.md", words(121), 121)).toEqual(tooLong(1, 121));
  });
});
