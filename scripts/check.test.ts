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

test("main sets a non-zero exit code and names the failed checks", async () => {
  await main(
    (script) => script !== "lint",
    [],
    () => Promise.resolve(true),
  );
  expect(process.exitCode).toBe(1);
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining("failed: lint"));
});

test("main says how to fix a failed format check", async () => {
  await main(
    (script) => script !== "format:check",
    [],
    () => Promise.resolve(true),
  );
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining("pnpm run format"));
});

test("main leaves the exit code alone when every check passes", async () => {
  const ran: string[] = [];
  await main(
    (script) => {
      ran.push(script);
      return true;
    },
    [],
    () => Promise.resolve(true),
  );
  expect(process.exitCode).toBeUndefined();
  expect(ran).toEqual([...checks]);
});

test("main without a reachable test database skips coverage, says how to start one, and fails", async () => {
  const ran: string[] = [];
  await main(
    (script) => {
      ran.push(script);
      return true;
    },
    [],
    () => Promise.resolve(false),
  );
  expect(ran).toEqual(checks.filter((script) => script !== "coverage"));
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining("failed: coverage"));
  expect(console.error).toHaveBeenLastCalledWith(
    expect.stringContaining("node scripts/test-db.ts"),
  );
  expect(process.exitCode).toBe(1);
});

test("main with --static runs every check but coverage", async () => {
  const ran: string[] = [];
  await main(
    (script) => {
      ran.push(script);
      return true;
    },
    ["--static"],
    () => Promise.reject(new Error("--static must not look for a database")),
  );
  expect(ran).toEqual(checks.filter((script) => script !== "coverage"));
});

test("main rejects an unknown argument by name", async () => {
  await expect(main(() => true, ["--statc"])).rejects.toThrow('Unknown argument "--statc"');
});

test("checks cover every pnpm script a CI job runs", () => {
  const ci = readFileSync(".github/workflows/ci.yml", "utf8");
  const inCi = Array.from(ci.matchAll(/run: pnpm (\S+)/gu), (match) => String(match[1]));
  expect(inCi.toSorted(byName)).toEqual([...checks].toSorted(byName));
});
