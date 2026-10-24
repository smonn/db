import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const ci = readFileSync(".github/workflows/ci.yml", "utf8");
const metadata = readFileSync(".github/workflows/pr.yml", "utf8");

const jobNames = (workflow: string): string[] =>
  Array.from(workflow.matchAll(/^ {4}name: (.+)$/gmu), (match) => String(match[1]));

const types = (workflow: string): string => String(/^ {4}types: (.+)$/mu.exec(workflow)?.[1]);

test("ci.yml does not run on a PR edit, so a title or body edit can't restart the code checks", () => {
  expect(types(ci)).not.toContain("edited");
});

test("the metadata workflow runs on a PR edit", () => {
  expect(types(metadata)).toContain("edited");
});

test("no job name holds an expression, since GitHub doesn't evaluate one in a skipped job", () => {
  expect([...jobNames(ci), ...jobNames(metadata)].filter((name) => name.includes("${{"))).toEqual(
    [],
  );
});

test("the code workflow keeps its job names, and the metadata workflow names its one job Metadata", () => {
  expect(jobNames(ci)).toEqual(
    expect.arrayContaining(["Docs", "Mermaid", "Typecheck", "Lint", "Test", "Required"]),
  );
  expect(jobNames(metadata)).toEqual(["Metadata"]);
});

test("the PR title check lives only in the metadata workflow", () => {
  expect(ci).not.toContain("check:pr");
  expect(metadata).toContain("run: pnpm check:pr");
});
