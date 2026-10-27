import { describe, expect, test } from "vitest";
import { findings, reportBody } from "./mutation-report.ts";
import { expecting, marker, report } from "./mutation-report.test-helper.ts";

describe("findings with a survivor count", () => {
  test("reports every survivor of a marked line that holds more than the marker expects", () => {
    const parsed = report(
      [
        { mutatorName: "StringLiteral", status: "Survived", line: 2 },
        { mutatorName: "StringLiteral", status: "NoCoverage", line: 2 },
        { mutatorName: "StringLiteral", status: "Killed", line: 2 },
      ],
      [marker, "g('x', 'y', 'z');"],
    );
    expect(findings(parsed)).toEqual({
      survivors: [
        { file: "src/a.ts", line: 2, mutator: "StringLiteral", status: "Survived", expected: 1 },
        { file: "src/a.ts", line: 2, mutator: "StringLiteral", status: "NoCoverage", expected: 1 },
      ],
      stale: [],
    });
  });

  test("counts the survivors of every mutator a marker names", () => {
    const mutators = "StringLiteral, BlockStatement";
    const source = [expecting(2, mutators), "g('x', () => {});"];
    const two = [
      { mutatorName: "StringLiteral", status: "Survived", line: 2 },
      { mutatorName: "BlockStatement", status: "Survived", line: 2 },
    ];
    expect(findings(report(two, source))).toEqual({ survivors: [], stale: [] });
    const three = [...two, { mutatorName: "BlockStatement", status: "Survived", line: 2 }];
    expect(findings(report(three, source)).survivors).toHaveLength(3);
  });

  test("leaves a survivor of another mutator on a marked line out of the count", () => {
    const parsed = report(
      [
        { mutatorName: "StringLiteral", status: "Survived", line: 2 },
        { mutatorName: "BlockStatement", status: "Survived", line: 2 },
      ],
      [marker, "g('x', () => {});"],
    );
    expect(findings(parsed)).toEqual({
      survivors: [{ file: "src/a.ts", line: 2, mutator: "BlockStatement", status: "Survived" }],
      stale: [],
    });
  });

  test("lists a marker that expects more survivors than the line has", () => {
    const parsed = report(
      [
        { mutatorName: "StringLiteral", status: "Survived", line: 2 },
        { mutatorName: "StringLiteral", status: "Killed", line: 2 },
      ],
      [expecting(2), "g('x', 'y');"],
    );
    expect(findings(parsed)).toEqual({
      survivors: [],
      stale: [{ file: "src/a.ts", line: 1, mutator: "StringLiteral", found: "1 survivor" }],
    });
  });

  test("doesn't count a timeout against a marker, since it may be a survivor on a loaded runner", () => {
    const parsed = report(
      [
        { mutatorName: "StringLiteral", status: "Survived", line: 2 },
        { mutatorName: "StringLiteral", status: "Timeout", line: 2 },
      ],
      [expecting(2), "g('x', 'y');"],
    );
    expect(findings(parsed).stale).toEqual([]);
  });

  test("lists the mutator of a marker that finds no mutant while another still survives", () => {
    const parsed = report(
      [{ mutatorName: "StringLiteral", status: "Survived", line: 2 }],
      [expecting(1, "StringLiteral, BlockStatement"), "g('x');"],
    );
    expect(findings(parsed)).toEqual({
      survivors: [],
      stale: [{ file: "src/a.ts", line: 1, mutator: "BlockStatement", found: "No mutant" }],
    });
  });

  test("lists a marker whose mutators fall short in total, and the count it found", () => {
    const parsed = report(
      [
        { mutatorName: "StringLiteral", status: "Survived", line: 2 },
        { mutatorName: "BlockStatement", status: "Survived", line: 2 },
      ],
      [expecting(3, "StringLiteral, BlockStatement"), "g('x', () => {});"],
    );
    expect(findings(parsed).stale).toEqual([
      { file: "src/a.ts", line: 1, mutator: "StringLiteral, BlockStatement", found: "2 survivors" },
    ]);
  });
});

describe("reportBody with a survivor count", () => {
  test("says what a disable above a survivor expects", () => {
    const row = {
      file: "src/b.ts",
      line: 3,
      mutator: "StringLiteral",
      status: "NoCoverage" as const,
    };
    expect(reportBody({ survivors: [{ ...row, expected: 2 }], stale: [] })).toContain(
      "| `src/b.ts` | 3 | StringLiteral | NoCoverage; the disable above expects 2 |\n",
    );
  });
});
