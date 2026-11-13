import { describe, expect, test } from "vitest";
import {
  changedLines,
  formatDuration,
  mutableChanges,
  splitSurvivors,
  summary,
} from "./mutation-pr.ts";
import type { Survivor } from "./mutation-report.ts";

const survivor = (file: string, line: number, extra: Partial<Survivor> = {}): Survivor => ({
  file,
  line,
  mutator: "StringLiteral",
  status: "Survived",
  ...extra,
});

const linesIn = (diff: string, file: string): number[] => [...(changedLines(diff).get(file) ?? [])];

describe("mutableChanges", () => {
  test("keeps the changed files that Stryker mutates, sorted", () => {
    const mutable = ["src/b.ts", "src/a.ts", "scripts/x.ts"];
    expect(mutableChanges(["src/b.ts", "README.md", "src/a.ts", "src/c.test.ts"], mutable)).toEqual(
      ["src/a.ts", "src/b.ts"],
    );
  });

  test("returns nothing when no changed file is mutable", () => {
    expect(mutableChanges(["README.md"], ["src/a.ts"])).toEqual([]);
  });
});

describe("changedLines", () => {
  test("collects the added lines of each hunk by file", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,0 +2,2 @@ head",
      "+x",
      "+y",
      "@@ -10 +12 @@",
      "-old",
      "+new",
      "diff --git a/src/b.ts b/src/b.ts",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -5,3 +5,0 @@",
      "-gone",
    ].join("\n");
    expect(linesIn(diff, "src/a.ts")).toEqual([2, 3, 12]);
    expect(changedLines(diff).get("src/b.ts")).toEqual(new Set());
  });

  test("reads multi-digit counts in both ranges", () => {
    const diff = ["+++ b/src/a.ts", "@@ -3,12 +20,11 @@"].join("\n");
    expect(linesIn(diff, "src/a.ts")).toEqual([20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30]);
  });

  test("reads a header and a hunk only at the start of a line", () => {
    const diff = ["+++ b/src/a.ts", "- +++ b/src/b.ts", "+@@ -1 +99 @@", "@@ -1 +4 @@"].join("\n");
    expect([...changedLines(diff).keys()]).toEqual(["src/a.ts"]);
    expect(linesIn(diff, "src/a.ts")).toEqual([4]);
  });

  test("ignores a deleted file and text before the first file", () => {
    const diff = ["--- a/src/a.ts", "+++ /dev/null", "@@ -1,2 +0,0 @@", "-a", "-b"].join("\n");
    expect(changedLines(diff).size).toBe(0);
    expect(changedLines("").size).toBe(0);
  });
});

describe("splitSurvivors", () => {
  test("separates survivors on changed lines from the rest, keeping order", () => {
    const lines = new Map([["src/a.ts", new Set([3, 4])]]);
    const list = [survivor("src/a.ts", 1), survivor("src/a.ts", 3), survivor("src/b.ts", 3)];
    expect(splitSurvivors(list, lines)).toEqual({
      onChanged: [survivor("src/a.ts", 3)],
      others: [survivor("src/a.ts", 1), survivor("src/b.ts", 3)],
    });
  });
});

describe("formatDuration", () => {
  test.each([
    [0, "0s"],
    [999, "0s"],
    [1000, "1s"],
    [59_999, "59s"],
    [60_000, "1m 0s"],
    [3_723_000, "62m 3s"],
  ])("%i ms is %s", (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});

describe("summary", () => {
  const base = {
    files: ["src/a.ts", "src/b.ts"],
    onChanged: [survivor("src/a.ts", 3)],
    others: [survivor("src/b.ts", 9, { status: "NoCoverage", expected: 1 })],
    stale: [{ file: "src/a.ts", line: 7, mutator: "StringLiteral", found: "No mutant" }],
    ms: 61_000,
  };

  test("lists changed-line survivors, then the others, then stale disables, then the run time", () => {
    const text = summary(base);
    const order = [
      "## Mutation on changed files",
      "Mutated 2 files",
      "### Survivors on lines this PR changed (1)",
      "| `src/a.ts` | 3 | StringLiteral | Survived |",
      "### Other survivors in the changed files (1)",
      "| `src/b.ts` | 9 | StringLiteral | NoCoverage; the disable above expects 1 |",
      "## Stale disables",
      "| `src/a.ts` | 7 | StringLiteral | No mutant |",
      "Run time: 1m 1s",
    ].map((part) => text.indexOf(part));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order).toEqual(order.toSorted((a, b) => a - b));
  });

  test("lays out the whole summary", () => {
    expect(summary({ ...base, files: ["src/a.ts"], others: [], stale: [] })).toBe(
      [
        "## Mutation on changed files",
        "",
        "Mutated 1 file: `src/a.ts`",
        "",
        "### Survivors on lines this PR changed (1)",
        "",
        "| File | Line | Mutator | Status |",
        "| --- | --- | --- | --- |",
        "| `src/a.ts` | 3 | StringLiteral | Survived |",
        "",
        "Run time: 1m 1s",
        "",
      ].join("\n"),
    );
    expect(summary({ ...base, onChanged: [], others: [], stale: [] })).toBe(
      [
        "## Mutation on changed files",
        "",
        "Mutated 2 files: `src/a.ts`, `src/b.ts`",
        "",
        "No mutant survives.",
        "",
        "Run time: 1m 1s",
        "",
      ].join("\n"),
    );
  });

  test("separates the count of rows left out from the table", () => {
    const many = Array.from({ length: 101 }, (_, i) => survivor("src/a.ts", i + 1));
    const lines = summary({ ...base, onChanged: many, others: [], stale: [] }).split("\n");
    const at = lines.indexOf("1 more not shown.");
    expect(lines.slice(at - 2, at + 1)).toEqual([
      "| `src/a.ts` | 100 | StringLiteral | Survived |",
      "",
      "1 more not shown.",
    ]);
  });

  test("names one file in the singular", () => {
    expect(summary({ ...base, files: ["src/a.ts"] })).toContain("Mutated 1 file:");
  });

  test("leaves out an empty section and says nothing survives", () => {
    const text = summary({ ...base, onChanged: [], others: [], stale: [] });
    expect(text).not.toContain("###");
    expect(text).not.toContain("Stale");
    expect(text).toContain("No mutant survives.");
    expect(text).toContain("Run time: 1m 1s");
  });

  test("leaves out the no-survivor line when one survives", () => {
    expect(summary({ ...base, others: [], stale: [] })).not.toContain("No mutant survives.");
    expect(summary({ ...base, onChanged: [], stale: [] })).not.toContain("No mutant survives.");
    expect(summary({ ...base, onChanged: [], others: [] })).not.toContain("No mutant survives.");
  });

  test("caps each table and counts the rows left out", () => {
    const many = Array.from({ length: 103 }, (_, i) => survivor("src/a.ts", i + 1));
    const text = summary({ ...base, onChanged: many, others: [], stale: [] });
    expect(text.split("\n").filter((line) => line.startsWith("| `src/a.ts`"))).toHaveLength(100);
    expect(text).toContain("3 more not shown.");
    const exact = summary({ ...base, onChanged: many.slice(0, 100), others: [], stale: [] });
    expect(exact).not.toContain("more not shown");
  });
});
