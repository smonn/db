import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { checks, main, runChecks } from "./check.ts";

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
