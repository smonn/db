import { describe, expect, it } from "vitest";
import { lineDiff } from "./line-diff.ts";

const numbered = (from: number, to: number): string[] =>
  Array.from({ length: to - from + 1 }, (_, i) => `l${from + i}`);

const bang = (rows: readonly string[], changed: readonly string[]): string[] =>
  rows.map((row) => `${row}${"!".repeat(Number(changed.includes(row)))}`);

const text = (rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

describe("lineDiff", () => {
  it("is empty for equal text", () => {
    expect(lineDiff("a\nb\n", "a\nb\n")).toBe("");
    expect(lineDiff("", "")).toBe("");
  });

  it("marks lines only in the first text with - and only in the second with +", () => {
    expect(lineDiff("a\nb\nc\n", "a\nx\nc\n")).toBe("@@ -1,3 +1,3 @@\n a\n-b\n+x\n c\n");
  });

  it("handles additions at the end and removals at the start", () => {
    expect(lineDiff("a\nb\n", "b\nc\n")).toBe("@@ -1,2 +1,2 @@\n-a\n b\n+c\n");
  });

  it("handles a removal at the end and an addition at the start", () => {
    expect(lineDiff("a\nb\n", "a\n")).toBe("@@ -1,2 +1,1 @@\n a\n-b\n");
    expect(lineDiff("a\n", "x\na\n")).toBe("@@ -1,1 +1,2 @@\n+x\n a\n");
  });

  it("is all additions from empty text and all removals to it", () => {
    expect(lineDiff("", "a\nb\n")).toBe("@@ -0,0 +1,2 @@\n+a\n+b\n");
    expect(lineDiff("a\nb\n", "")).toBe("@@ -1,2 +0,0 @@\n-a\n-b\n");
  });

  it("removes before it adds when both orders keep as many lines", () => {
    expect(lineDiff("x\na\n", "b\na\n")).toBe("@@ -1,2 +1,2 @@\n-x\n+b\n a\n");
  });

  it("adds the lines before a shared one rather than dropping it", () => {
    expect(lineDiff("a\n", "b\nb\na\n")).toBe("@@ -1,1 +1,3 @@\n+b\n+b\n a\n");
  });

  it("keeps the longest run of shared lines", () => {
    expect(lineDiff("a\nb\nc\nd\ne\n", "b\nx\nd\ny\ne\n")).toBe(
      "@@ -1,5 +1,5 @@\n-a\n b\n-c\n+x\n d\n+y\n e\n",
    );
  });

  it("diffs repeated lines by position", () => {
    expect(lineDiff("a\na\na\n", "a\na\n")).toBe("@@ -1,3 +1,2 @@\n a\n a\n-a\n");
    expect(lineDiff("a\nb\na\nb\n", "a\nb\n")).toBe("@@ -1,4 +1,2 @@\n a\n b\n-a\n-b\n");
  });

  it("counts a trailing blank line as a line", () => {
    expect(lineDiff("a\n\n", "a\n")).toBe("@@ -1,2 +1,1 @@\n a\n-\n");
    expect(lineDiff("a\n", "a\n\n")).toBe("@@ -1,1 +1,2 @@\n a\n+\n");
  });

  it("reads text with and without a final newline alike", () => {
    expect(lineDiff("a\nb", "a\nb\n")).toBe("");
  });

  it("numbers a one-line edit at the top of a long file from 1 with 3 lines of context", () => {
    const rows = numbered(1, 20);
    const edited = ["x", ...rows.slice(1)];

    expect(lineDiff(text(rows), text(edited))).toBe(
      `@@ -1,4 +1,4 @@\n-l1\n+x\n${text(rows.slice(1, 4).map((row) => ` ${row}`))}`,
    );
  });

  it("numbers a change deep in a file by its position on each side", () => {
    const rows = numbered(1, 20);
    const edited = [...rows.slice(0, 9), "x", "y", ...rows.slice(10)];

    expect(lineDiff(text(rows), text(edited))).toBe(
      `@@ -7,7 +7,8 @@\n${text(rows.slice(6, 9).map((row) => ` ${row}`))}-l10\n+x\n+y\n${text(
        rows.slice(10, 13).map((row) => ` ${row}`),
      )}`,
    );
  });

  it("splits changes more than 6 lines apart into separate hunks", () => {
    const rows = numbered(1, 20);
    const edited = bang(rows, ["l3", "l11"]);

    expect(lineDiff(text(rows), text(edited))).toBe(
      [
        "@@ -1,6 +1,6 @@",
        " l1",
        " l2",
        "-l3",
        "+l3!",
        " l4",
        " l5",
        " l6",
        "@@ -8,7 +8,7 @@",
        " l8",
        " l9",
        " l10",
        "-l11",
        "+l11!",
        " l12",
        " l13",
        " l14",
        "",
      ].join("\n"),
    );
  });

  it("merges changes exactly 6 lines apart into one hunk", () => {
    const rows = numbered(1, 20);
    const edited = bang(rows, ["l3", "l10"]);

    const diff = lineDiff(text(rows), text(edited));

    expect(diff.match(/^@@/gmu)).toHaveLength(1);
    expect(diff.startsWith("@@ -1,13 +1,13 @@\n")).toBe(true);
  });

  it("numbers a later hunk by the lines either side gained or lost before it", () => {
    const rows = numbered(1, 30);
    const edited = [
      ...rows.slice(0, 1),
      "a",
      "b",
      "c",
      ...rows.slice(1, 25),
      "z",
      ...rows.slice(25),
    ];

    const headers = lineDiff(text(rows), text(edited)).match(/^@@.*@@$/gmu);

    expect(headers).toStrictEqual(["@@ -1,4 +1,7 @@", "@@ -23,6 +26,7 @@"]);
  });
});
