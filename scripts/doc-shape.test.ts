import { describe, expect, test } from "vitest";
import { checkBudget, checkLinks, headingAnchors } from "./doc-shape.ts";

describe("headingAnchors", () => {
  test("slugs headings as GitHub does, numbering repeats", () => {
    const text = "# Title\n\n## runtime/ components\n\n### `generate`\n\n## Title\n";
    expect([...headingAnchors(text)]).toEqual([
      "title",
      "runtime-components",
      "generate",
      "title-1",
    ]);
  });

  test("skips headings inside code fences", () => {
    expect([...headingAnchors("```sh\n# not a heading\n```\n## Real\n")]).toEqual(["real"]);
  });
});

describe("checkLinks", () => {
  const files: Record<string, string> = {
    "docs/a.md": "# A\n\n## Ports\n",
    "src/x.ts": "",
  };
  const read = (path: string): string | undefined => files[path];

  test("passes links to existing files and headings", () => {
    const text =
      "[a](a.md) [ports](a.md#ports) [x](../src/x.ts) [self](#b) [web](https://x.dev/#y)\n\n## B\n";
    expect(checkLinks("docs/b.md", text, read)).toEqual([]);
  });

  test("flags a missing file and a missing heading", () => {
    const text = "See [gone](gone.md).\nSee [a](a.md#nope) and [self](#nope).\n";
    expect(checkLinks("docs/b.md", text, read)).toEqual([
      { file: "docs/b.md", line: 1, message: "link to missing file gone.md" },
      { file: "docs/b.md", line: 2, message: "link to missing heading a.md#nope" },
      { file: "docs/b.md", line: 2, message: "link to missing heading #nope" },
    ]);
  });

  test("ignores links in code", () => {
    expect(checkLinks("docs/b.md", "`[a](gone.md)`\n```md\n[a](gone.md)\n```\n", read)).toEqual([]);
  });
});

describe("checkBudget", () => {
  const long = Array.from({ length: 121 }, () => "word").join(" ");

  test("passes a file within its cap", () => {
    expect(checkBudget("docs/a.md", "# A\n\nOne two three.\n", 10)).toEqual([]);
  });

  test("flags a file over its cap, not counting code fences", () => {
    const text = "# A\n\nOne two three.\n\n```mermaid\nflowchart TB\n  a --> b\n```\n";
    expect(checkBudget("docs/a.md", text, 3)).toEqual([
      {
        file: "docs/a.md",
        line: 1,
        message:
          "4 words; the cap is 3. Move behavior inside one module to its TSDoc, a decision to an ADR, or cut",
      },
    ]);
  });

  test("flags a paragraph, list item, or table row over 120 words", () => {
    const text = `# A\n\n${long}\n\n- ${long}\n- short\n\n| a |\n| - |\n| ${long} |\n`;
    const message = "block has 121 words; the cap is 120. Split it by topic or cut";
    expect(checkBudget("docs/a.md", text, 1000)).toEqual([
      { file: "docs/a.md", line: 3, message },
      { file: "docs/a.md", line: 5, message },
      { file: "docs/a.md", line: 10, message },
    ]);
  });
});
