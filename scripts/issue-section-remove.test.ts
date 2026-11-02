import { describe, expect, test } from "vitest";
import { removeFromSection } from "./issue-section.ts";

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

describe("removeFromSection", () => {
  test("deletes the line from the section and leaves the rest alone", () => {
    expect(removeFromSection(body, "## Decisions so far", ["- first"])).toBe(
      body.replace("- first\n", ""),
    );
  });

  test("deletes several lines", () => {
    expect(removeFromSection(body, "## Decisions so far", ["- inner", "- first"])).toBe(
      body.replace("- first\n", "").replace("- inner\n", ""),
    );
  });

  test("keeps the same text in another section", () => {
    const text = "## A\n- x\n\n## B\n- x\n- y\n";
    expect(removeFromSection(text, "## A", ["- x"])).toBe("## A\n\n## B\n- x\n- y\n");
    expect(removeFromSection(text, "## B", ["- x"])).toBe("## A\n- x\n\n## B\n- y\n");
  });

  test("matches the whole line, not part of it", () => {
    expect(() => removeFromSection(body, "## Decisions so far", ["- fir"])).toThrow(
      'not in "## Decisions so far": "- fir"',
    );
    expect(() => removeFromSection(body, "## Decisions so far", ["first"])).toThrow("not in");
    expect(() => removeFromSection("## A\n- x \n", "## A", ["- x"])).toThrow("not in");
  });

  test("deletes every copy of a repeated line in the section", () => {
    expect(removeFromSection("## A\n- x\n- y\n- x\n", "## A", ["- x"])).toBe("## A\n- y\n");
  });

  test("keeps a line inside a code fence", () => {
    const text = "## A\n- x\n```\n- x\n```\n";
    expect(removeFromSection(text, "## A", ["- x"])).toBe("## A\n```\n- x\n```\n");
  });

  test("does not take the heading line or a line of the next section", () => {
    expect(() => removeFromSection("## A\n- x\n## B\n- y\n", "## A", ["## A"])).toThrow(
      'not in "## A"',
    );
    expect(() => removeFromSection("## A\n- x\n## B\n- y\n", "## A", ["- y"])).toThrow(
      'not in "## A"',
    );
  });

  test("handles a subsection and its parent separately", () => {
    expect(removeFromSection(body, "### Detail", ["- inner"])).toBe(body.replace("- inner\n", ""));
  });

  test("matches a line that ends in a carriage return", () => {
    expect(removeFromSection("## A\r\n- x\r\n- y\r\n", "## A", ["- x"])).toBe("## A\r\n- y\r\n");
  });

  test("matches a carriage return only at the end of the line", () => {
    expect(() => removeFromSection("## A\n- a\rb\n", "## A", ["- ab"])).toThrow("not in");
  });

  test("never removes the next section's heading", () => {
    expect(() => removeFromSection("## A\n- x\n## B\n- y\n", "## A", ["## B"])).toThrow(
      'not in "## A"',
    );
    expect(() => removeFromSection("## A\n- x\n## B", "## A", ["## B"])).toThrow("not in");
  });

  test("ignores blank lines in the list to remove", () => {
    expect(removeFromSection("## A\n  \n- x\n", "## A", ["  ", "- x"])).toBe("## A\n  \n");
    expect(removeFromSection("## A\n- x\n\n- y\n", "## A", ["", "- x"])).toBe("## A\n\n- y\n");
  });

  test("names every missing line and throws before returning anything", () => {
    expect(() => removeFromSection("## A\n- x\n", "## A", ["- x", "- p", "- q"])).toThrow(
      'not in "## A": "- p", "- q"',
    );
  });

  test("throws when the heading is missing or repeated", () => {
    expect(() => removeFromSection(body, "## Missing", ["- x"])).toThrow(
      'no "## Missing" heading in the issue body',
    );
    expect(() => removeFromSection("## A\n- x\n## A\n- x\n", "## A", ["- x"])).toThrow(
      '"## A" appears 2 times',
    );
  });
});
