import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { findings, main, reportBody } from "./mutation-report.ts";
import { expecting, marker, report } from "./mutation-report.test-helper.ts";

describe("findings", () => {
  test("leaves out a survivor that a marker on the line above expects, in any case", () => {
    const parsed = report(
      [
        { mutatorName: "stringliteral", status: "Survived", line: 3 },
        { mutatorName: "StringLiteral", status: "NoCoverage", line: 3 },
        { mutatorName: "BlockStatement", status: "Survived", line: 3 },
        { mutatorName: "StringLiteral", status: "Survived", line: 4 },
      ],
      ["f();", expecting(2), "g('x');", "h('y');"],
    );
    expect(findings(parsed)).toEqual({
      survivors: [
        { file: "src/a.ts", line: 3, mutator: "BlockStatement", status: "Survived" },
        { file: "src/a.ts", line: 4, mutator: "StringLiteral", status: "Survived" },
      ],
      stale: [],
    });
  });

  test("lists a marker whose mutant a test kills, or that has none", () => {
    const parsed = report(
      [
        { mutatorName: "StringLiteral", status: "Killed", line: 2 },
        { mutatorName: "StringLiteral", status: "Timeout", line: 2 },
        { mutatorName: "StringLiteral", status: "Survived", line: 5 },
      ],
      [marker, "g('x');", expecting(1, "ArrayDeclaration, StringLiteral"), "h();"],
    );
    expect(findings(parsed).stale).toEqual([
      { file: "src/a.ts", line: 1, mutator: "StringLiteral", found: "Killed, Timeout" },
      { file: "src/a.ts", line: 3, mutator: "ArrayDeclaration", found: "No mutant" },
      { file: "src/a.ts", line: 3, mutator: "StringLiteral", found: "No mutant" },
    ]);
  });

  test("keeps a marker that hides one survivor among killed mutants", () => {
    const parsed = report(
      [
        { mutatorName: "StringLiteral", status: "Killed", line: 2 },
        { mutatorName: "StringLiteral", status: "Survived", line: 2 },
      ],
      [marker, "g('x', 'y');"],
    );
    expect(findings(parsed)).toEqual({ survivors: [], stale: [] });
  });

  test("keeps a marker whose mutants only time out", () => {
    const parsed = report(
      [
        { mutatorName: "StringLiteral", status: "Timeout", line: 2 },
        { mutatorName: "StringLiteral", status: "Timeout", line: 2 },
      ],
      [marker, "g('x', 'y');"],
    );
    expect(findings(parsed).stale).toEqual([]);
  });
});

describe("reportBody", () => {
  const stale = [{ file: "src/a.ts", line: 1, mutator: "StringLiteral", found: "Killed" }];

  const survivors = [
    { file: "src/b.ts", line: 3, mutator: "BlockStatement", status: "Survived" as const },
  ];

  test("lists stale disables before the survivors", () => {
    expect(reportBody({ survivors, stale })).toBe(
      [
        "The weekly Stryker run leaves 1 mutants that no test kills, and 1 stale disables. Each run rewrites this issue, and closes it once neither is left.",
        "",
        "## Stale disables",
        "",
        "Each `Stryker disable` comment below states more survivors than its mutators have on the next line. Delete it, or fix its mutators or its count.",
        "",
        "| File | Line | Mutator | Found |",
        "| --- | --- | --- | --- |",
        "| `src/a.ts` | 1 | StringLiteral | Killed |",
        "",
        "## Survivors",
        "",
        "| File | Line | Mutator | Status |",
        "| --- | --- | --- | --- |",
        "| `src/b.ts` | 3 | BlockStatement | Survived |",
        "",
      ].join("\n"),
    );
  });

  test("leaves out an empty section", () => {
    expect(reportBody({ survivors: [], stale })).toMatch(
      /stale disables\.[^\n]*\n\n## Stale disables\n[^#]*\| Killed \|\n$/u,
    );
    expect(reportBody({ survivors, stale: [] }).split("\n").slice(0, 3)).toEqual([
      "The weekly Stryker run leaves 1 mutants that no test kills, and 0 stale disables. Each run rewrites this issue, and closes it once neither is left.",
      "",
      "## Survivors",
    ]);
  });
});

const ghWithOpenIssue = () =>
  vi.fn<(args: string[], input?: string) => string>((args) =>
    args[1] === "list" ? JSON.stringify([{ number: 41 }]) : "",
  );

describe("main", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("keeps the report issue open for a stale disable alone", () => {
    const path = join(mkdtempSync(join(tmpdir(), "mutation-report-")), "mutation.json");
    const parsed = report(
      [{ mutatorName: "StringLiteral", status: "Killed", line: 2 }],
      [marker, "g('x');"],
    );
    writeFileSync(path, JSON.stringify(parsed));
    const gh = ghWithOpenIssue();
    main([path], { GITHUB_REPOSITORY: "smonn/db" }, gh);
    expect(gh).toHaveBeenNthCalledWith(
      2,
      ["issue", "edit", "41", "--repo", "smonn/db", "--body-file", "-"],
      expect.stringContaining("## Stale disables"),
    );
    expect(gh).toHaveBeenCalledTimes(2);
  });
});
