import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { checks, main, runChecks } from "./check.ts";

const byName = (a: string, b: string) => a.localeCompare(b);

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

test("runChecks runs every script after a failure and returns the failed ones", () => {
  const ran: string[] = [];
  const failed = runChecks(["a", "b", "c"], (script) => {
    ran.push(script);
    return script === "b";
  });
  expect(ran).toEqual(["a", "b", "c"]);
  expect(failed).toEqual(["a", "c"]);
});

test("main sets a non-zero exit code and names the failed checks", () => {
  main((script) => script !== "lint");
  expect(process.exitCode).toBe(1);
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining("failed: lint"));
});

test("main leaves the exit code alone when every check passes", () => {
  const ran: string[] = [];
  main((script) => {
    ran.push(script);
    return true;
  });
  expect(process.exitCode).toBeUndefined();
  expect(ran).toEqual([...checks]);
});

test("main with --static runs every check but coverage", () => {
  const ran: string[] = [];
  main(
    (script) => {
      ran.push(script);
      return true;
    },
    ["--static"],
  );
  expect(ran).toEqual(checks.filter((script) => script !== "coverage"));
});

test("checks cover every pnpm script a CI job runs, except the PR-only check", () => {
  const ci = readFileSync(".github/workflows/ci.yml", "utf8");
  const inCi = Array.from(ci.matchAll(/run: pnpm (\S+)/gu), (match) => String(match[1]));
  expect(inCi.filter((script) => script !== "check:pr").toSorted(byName)).toEqual(
    [...checks].toSorted(byName),
  );
});
