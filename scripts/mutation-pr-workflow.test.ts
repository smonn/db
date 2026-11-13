import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const ci = readFileSync(".github/workflows/ci.yml", "utf8");
const weekly = readFileSync(".github/workflows/mutation.yml", "utf8");
const pr = readFileSync(".github/workflows/mutation-pr.yml", "utf8");

const pins = (workflow: string): string[] =>
  Array.from(workflow.matchAll(/(?:uses: |image: )(\S+@\S+)/gu), (match) => String(match[1]));

test("runs on a pull request, never on a schedule", () => {
  expect(pr).toMatch(/^on:\n {2}pull_request:/mu);
  expect(pr).not.toContain("schedule:");
});

test("reads contents only and cancels an older run of the same PR", () => {
  expect(pr).toMatch(/^permissions:\n {2}contents: read\n/mu);
  expect(pr).toContain("github.event.pull_request.number");
  expect(pr).toContain("cancel-in-progress: true");
});

test("keeps out of the Required job, and its job name matches no required check", () => {
  const needs = String(/^ {4}needs: (.+)$/mu.exec(ci)?.[1]);
  expect(needs).not.toContain("mutation-pr");
  expect(pr).toContain("name: Mutation on changed files");
  expect(ci).not.toContain("Mutation on changed files");
});

test("pins its actions and the Postgres image like the weekly run", () => {
  expect(pins(pr).length).toBeGreaterThan(0);
  expect(pins(pr).filter((pin) => !weekly.includes(pin))).toEqual([]);
});

test("marks the disables, then reports", () => {
  expect(pr.indexOf("run: pnpm mutation:mark")).toBeGreaterThan(0);
  expect(pr.indexOf("run: pnpm mutation:pr")).toBeGreaterThan(
    pr.indexOf("run: pnpm mutation:mark"),
  );
});

test("sets a timeout", () => {
  expect(pr).toMatch(/^ {4}timeout-minutes: \d+$/mu);
});

test("the weekly header still says it never runs on pull requests", () => {
  expect(weekly).toContain("never runs on pull requests");
});
