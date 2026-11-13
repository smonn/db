import { describe, expect, test } from "vitest";
import { describeOne, mutant, reportOf } from "./mutation-disables.test-helper.ts";
import { describeDisables } from "./mutation-disables.ts";
import { findings } from "./mutation-report.ts";

describe("describeDisables for a disable that names several mutators", () => {
  test("reports a stale mutator even when the survivors of the others make up the count", () => {
    const source =
      "// Stryker expect next-line StringLiteral, BlockStatement: 2 survivors: both\nf('x');\n";
    const mutants = [
      mutant("StringLiteral", "Survived"),
      mutant("StringLiteral", "NoCoverage"),
      mutant("BlockStatement", "Killed"),
    ];
    expect(describeOne(mutants, source)).toEqual([
      "a.ts:1 states 2, survivors 2 (StringLiteral 2, BlockStatement 0): a mutator it names has none: stale",
    ]);
  });

  test("lets a mutator that only timed out stand in for its survivor, as the report does", () => {
    const source =
      "// Stryker expect next-line StringLiteral, BlockStatement: 2 survivors: both\nf('x');\n";
    const mutants = [
      mutant("StringLiteral", "Survived"),
      mutant("StringLiteral", "NoCoverage"),
      mutant("BlockStatement", "Timeout"),
    ];
    expect(describeOne(mutants, source)).toEqual([
      "a.ts:1 states 2, survivors 2 (StringLiteral 2, BlockStatement 0): matches",
    ]);
  });

  test("counts a timeout toward the stated survivors before it calls a mutator stale", () => {
    const source =
      "// Stryker expect next-line StringLiteral, BlockStatement: 2 survivors: both\nf('x');\n";
    const mutants = [
      mutant("StringLiteral", "Survived"),
      mutant("StringLiteral", "Timeout"),
      mutant("BlockStatement", "Killed"),
    ];
    expect(describeOne(mutants, source)).toEqual([
      "a.ts:1 states 2, survivors 1 (StringLiteral 1, BlockStatement 0): a mutator it names has none: stale",
    ]);
  });

  test("reports both problems when a stale mutator comes with more survivors than stated", () => {
    const source =
      "// Stryker expect next-line StringLiteral, BlockStatement: 1 survivor: both\nf('x');\n";
    const mutants = [
      mutant("StringLiteral", "Survived"),
      mutant("StringLiteral", "NoCoverage"),
      mutant("BlockStatement", "Killed"),
    ];
    expect(describeOne(mutants, source)).toEqual([
      "a.ts:1 states 1, survivors 2 (StringLiteral 2, BlockStatement 0): more survivors than stated: the weekly run lists them all; a mutator it names has none: stale",
    ]);
  });

  test("agrees with the weekly report on whether a disable is stale", () => {
    const source =
      "// Stryker expect next-line StringLiteral, BlockStatement: 2 survivors: both\nf('x');\n";
    const sets = [
      [mutant("StringLiteral", "Survived"), mutant("BlockStatement", "Survived")],
      [mutant("StringLiteral", "Survived"), mutant("StringLiteral", "NoCoverage")],
      [mutant("StringLiteral", "Survived"), mutant("BlockStatement", "Timeout")],
      [mutant("StringLiteral", "Killed"), mutant("BlockStatement", "Killed")],
      [mutant("StringLiteral", "Survived")],
    ];
    for (const mutants of sets) {
      const report: unknown = JSON.parse(reportOf({ "a.ts": { source, mutants } }));
      const stale = findings(report).stale.length > 0;
      expect(describeDisables(report)[0]?.endsWith("stale")).toBe(stale);
    }
  });
});
