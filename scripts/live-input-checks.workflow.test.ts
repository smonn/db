import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { expect, test } from "vitest";
import { field, parseJson, record, string } from "./github-json.ts";
import { CHECKS, RUNNER_FILES } from "./live-input-checks.ts";

const workflow = readFileSync(".github/workflows/live-input-checks.yml", "utf8");
const ci = readFileSync(".github/workflows/ci.yml", "utf8");
const scripts = field(
  record(parseJson(readFileSync("package.json", "utf8"), "package.json"), "$"),
  "scripts",
  record,
  "$",
);

/** The script file a package.json script runs with `node`. */
function entryOf(name: string): string {
  const command = field(scripts, name, string, "scripts");
  const entry = /node (scripts\/\S+\.ts)/u.exec(command)?.[1];
  if (entry === undefined) throw new Error(`${name} runs no script: ${command}`);
  return entry;
}

const triggerPaths = (): string[] =>
  Array.from(workflow.matchAll(/^ {6}- "(.+)"$/gmu), (match) => String(match[1]));

/** The non-test scripts a file imports, followed through their own imports. */
function reachable(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  const text = readFileSync(entry, "utf8");
  for (const match of text.matchAll(/from "(\.\/[^"]+\.ts)"/gu)) {
    reachable(normalize(join(dirname(entry), String(match[1]))), seen);
  }
  return seen;
}

test.each(CHECKS.map((check) => [check.name, check] as const))(
  "%s lists exactly the scripts its package.json entry reaches",
  (name, check) => {
    expect(check.files.toSorted()).toEqual([...reachable(entryOf(name))].toSorted());
  },
);

test("the runner files are the workflow and every live-input script the runner reaches", () => {
  const reached = [...reachable("scripts/live-input-checks.ts")].filter((file) =>
    file.startsWith("scripts/live-input-"),
  );
  expect(RUNNER_FILES.toSorted()).toEqual(
    [".github/workflows/live-input-checks.yml", ...reached].toSorted(),
  );
});

test("the workflow runs on the files of every check and of the runner, and no others", () => {
  const expected = new Set([...CHECKS.flatMap((check) => check.files), ...RUNNER_FILES]);
  expect(triggerPaths().toSorted()).toEqual([...expected].toSorted());
});

test("the runner has a package.json script", () => {
  expect(entryOf("check:live")).toBe("scripts/live-input-checks.ts");
  expect(workflow).toContain("run: pnpm check:live");
});

test("the token can only read, at the workflow and at the job", () => {
  expect(workflow).toMatch(
    /^permissions:\n {2}contents: read\n {2}issues: read\n {2}pull-requests: read\n/mu,
  );
  expect(workflow).not.toMatch(/: write/u);
});

test("it needs full history, so check:pr can diff a merged PR's commit against its parent", () => {
  expect(workflow).toContain("fetch-depth: 0");
});

test("it stays out of ci.yml, and Required doesn't wait on it", () => {
  const needs = String(/^ {4}needs: (.+)$/mu.exec(ci)?.[1]);
  expect(needs).not.toContain("live-input");
  expect(ci).not.toContain("Live input checks");
  expect(ci).not.toContain("check:live");
});

test("it cancels an older run of the same PR and sets a timeout", () => {
  expect(workflow).toContain("cancel-in-progress: true");
  expect(workflow).toMatch(/^ {4}timeout-minutes: \d+$/mu);
});
