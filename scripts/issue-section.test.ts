import { describe, expect, test } from "vitest";
import { appendToSection, parseLines } from "./issue-section.ts";

const body = [
  "## Notes",
  "",
  "- note",
  "",
  "## Decisions so far",
  "",
  "- first",
  "- second",
  "  wrapped",
  "",
  "### Detail",
  "",
  "- inner",
  "",
  "## Out of scope",
  "",
  "- nothing",
  "",
].join("\n");

describe("appendToSection", () => {
  test("adds the lines after the section's last list item and leaves the rest alone", () => {
    expect(appendToSection(body, "## Decisions so far", ["- third"])).toBe(
      body.replace("- inner\n", "- inner\n- third\n"),
    );
  });

  test("adds several lines in order", () => {
    const result = appendToSection(body, "## Out of scope", ["- a", "- b"]);
    expect(result).toBe(body.replace("- nothing\n", "- nothing\n- a\n- b\n"));
  });

  test("keeps a body that ends without a line break", () => {
    expect(appendToSection("## A\n\n- x", "## A", ["- y"])).toBe("## A\n\n- x\n- y");
  });

  test("appends to a subsection by its own heading", () => {
    expect(appendToSection(body, "### Detail", ["- more"])).toBe(
      body.replace("- inner\n", "- inner\n- more\n"),
    );
  });

  test("goes after the wrapped lines of the last item", () => {
    const result = appendToSection("## A\n- x\n  wrapped\n  again\n\nprose\n", "## A", ["- y"]);
    expect(result).toBe("## A\n- x\n  wrapped\n  again\n- y\n\nprose\n");
  });

  test("goes after a lazy continuation line", () => {
    const result = appendToSection("## A\n- x\nlazy\n\n## B\n", "## A", ["- y"]);
    expect(result).toBe("## A\n- x\nlazy\n- y\n\n## B\n");
  });

  test("keeps a loose item's indented paragraph with the item", () => {
    const result = appendToSection("## A\n- x\n\n  more of x\n\nprose\n", "## A", ["- y"]);
    expect(result).toBe("## A\n- x\n\n  more of x\n- y\n\nprose\n");
  });

  test("goes after a numbered item", () => {
    expect(appendToSection("## A\n1. x\n2) y\n", "## A", ["3. z"])).toBe(
      "## A\n1. x\n2) y\n3. z\n",
    );
  });

  test("starts a list after the prose when the section has none", () => {
    expect(appendToSection("## A\n\nprose\n\n## B\n", "## A", ["- y"])).toBe(
      "## A\n\nprose\n\n- y\n\n## B\n",
    );
  });

  test("fills an empty section", () => {
    expect(appendToSection("## A\n## B\n", "## A", ["- y"])).toBe("## A\n\n- y\n## B\n");
    expect(appendToSection("## A", "## A", ["- y"])).toBe("## A\n\n- y");
  });

  test("ignores headings and list items inside a code fence", () => {
    const fenced = "## A\n\n- x\n\n```md\n## B\n- code\n```\n\n## C\n";
    expect(appendToSection(fenced, "## A", ["- y"])).toBe(
      "## A\n\n- x\n- y\n\n```md\n## B\n- code\n```\n\n## C\n",
    );
    expect(() => appendToSection(fenced, "## B", ["- y"])).toThrow('no "## B" heading');
  });

  test("closes a fence only with its own marker", () => {
    const text = "## A\n~~~\n```\n## B\n~~~\n";
    expect(() => appendToSection(text, "## B", ["- y"])).toThrow('no "## B" heading');
    expect(() => appendToSection("## A\n```\n~~~\n## B\n```\n", "## B", ["- y"])).toThrow(
      'no "## B" heading',
    );
  });

  test("matches the heading line exactly", () => {
    const text = "## Decisions so far and more\n- x\n## Decisions\n- y\n";
    expect(() => appendToSection(text, "## Decisions so far", ["- z"])).toThrow("no ");
    expect(appendToSection(text, "## Decisions", ["- z"])).toBe(
      "## Decisions so far and more\n- x\n## Decisions\n- y\n- z\n",
    );
  });

  test("does not match a heading of another level", () => {
    expect(() => appendToSection("### A\n- x\n", "## A", ["- y"])).toThrow('no "## A" heading');
  });

  test("ignores trailing space on the heading line", () => {
    expect(appendToSection("## A  \n- x\n", "## A", ["- y"])).toBe("## A  \n- x\n- y\n");
  });

  test("does not read a hash line without a space as a heading", () => {
    expect(appendToSection("## A\n- x\n\n#tag\n- z\n", "## A", ["- y"])).toBe(
      "## A\n- x\n\n#tag\n- z\n- y\n",
    );
  });

  test("keeps CRLF line endings", () => {
    expect(appendToSection("## A\r\n\r\n- x\r\n\r\n## B\r\n", "## A", ["- y"])).toBe(
      "## A\r\n\r\n- x\r\n- y\r\n\r\n## B\r\n",
    );
    expect(appendToSection("## A\r\n\r\nprose\r\n", "## A", ["- y"])).toBe(
      "## A\r\n\r\nprose\r\n\r\n- y\r\n",
    );
  });

  test("keeps CRLF line endings when the append point is the last line with no final break", () => {
    expect(appendToSection("## A\r\n- a", "## A", ["- y"])).toBe("## A\r\n- a\r\n- y");
    expect(appendToSection("## A\r\nprose", "## A", ["- y"])).toBe("## A\r\nprose\r\n\r\n- y");
    expect(appendToSection("## A\r\n- a", "## A", ["- y", "- z"])).toBe(
      "## A\r\n- a\r\n- y\r\n- z",
    );
  });

  test("appends after a list indented one to three spaces, not after the prose that follows", () => {
    expect(appendToSection("## A\n\n  - x\n\nprose\n", "## A", ["- y"])).toBe(
      "## A\n\n  - x\n- y\n\nprose\n",
    );
  });

  test("closes a fence and reads the headings after it", () => {
    const text = "## A\n- x\n```\n## B\n```\n## C\n- z\n";
    expect(appendToSection(text, "## C", ["- y"])).toBe(text + "- y\n");
  });

  test("does not read a short run of backticks, or one mid-line, as a fence", () => {
    const short = "## A\n- x\n\n``a`` b\n\n## B\n- z\n";
    expect(appendToSection(short, "## B", ["- y"])).toBe(short.replace("- z\n", "- z\n- y\n"));
    const inline = "## A\n- x\nuse ``` here\n\n## B\n- z\n";
    expect(appendToSection(inline, "## B", ["- y"])).toBe(inline.replace("- z\n", "- z\n- y\n"));
  });

  test("reads a hash line with no text as a heading", () => {
    expect(appendToSection("## A\n- x\n##\n- z\n", "## A", ["- y"])).toBe(
      "## A\n- x\n- y\n##\n- z\n",
    );
  });

  test("does not read a heading in the middle of a line", () => {
    expect(appendToSection("## A\n- x\nsee ## B text\n- z\n", "## A", ["- y"])).toBe(
      "## A\n- x\nsee ## B text\n- z\n- y\n",
    );
  });

  test("does not read a dash in the middle of a line as a list item", () => {
    expect(appendToSection("## A\n- x\n\nprose - with dash\n", "## A", ["- y"])).toBe(
      "## A\n- x\n- y\n\nprose - with dash\n",
    );
  });

  test("reads a multi-digit number as a list item", () => {
    expect(appendToSection("## A\n\n10. b\n\nprose\n", "## A", ["11. c"])).toBe(
      "## A\n\n10. b\n11. c\n\nprose\n",
    );
  });

  test("stops at prose that holds a space after a blank line", () => {
    expect(appendToSection("## A\n- x\n\nsome prose\n", "## A", ["- y"])).toBe(
      "## A\n- x\n- y\n\nsome prose\n",
    );
  });

  test("keeps going past a lazy line that follows an indented paragraph", () => {
    expect(appendToSection("## A\n- x\n\n  para\nlazy\n\nprose\n", "## A", ["- y"])).toBe(
      "## A\n- x\n\n  para\nlazy\n- y\n\nprose\n",
    );
  });

  test("sets a new list after the last content, not after blank lines that hold space", () => {
    expect(appendToSection("## A\n\nprose\n  \n\n## B\n", "## A", ["- y"])).toBe(
      "## A\n\nprose\n\n- y\n  \n\n## B\n",
    );
    expect(appendToSection("## A\r\n\r\nprose\r\n\r\n## B\r\n", "## A", ["- y"])).toBe(
      "## A\r\n\r\nprose\r\n\r\n- y\r\n\r\n## B\r\n",
    );
  });

  test("throws, naming the heading, when it is missing", () => {
    expect(() => appendToSection(body, "## Missing", ["- x"])).toThrow(
      'no "## Missing" heading in the issue body',
    );
    expect(() => appendToSection("", "## A", ["- x"])).toThrow('no "## A" heading');
  });

  test("throws when the heading appears twice", () => {
    expect(() => appendToSection("## A\n- x\n## A\n- y\n", "## A", ["- z"])).toThrow(
      '"## A" appears 2 times',
    );
  });
});

describe("parseLines", () => {
  test("splits on line breaks and drops the final one", () => {
    expect(parseLines("- a\n- b\n")).toEqual(["- a", "- b"]);
    expect(parseLines("- a\r\n- b\r\n")).toEqual(["- a", "- b"]);
    expect(parseLines("- a")).toEqual(["- a"]);
  });

  test("keeps interior blank lines and drops only one final break", () => {
    expect(parseLines("- a\n\n- b\n\n")).toEqual(["- a", "", "- b", ""]);
  });
});
