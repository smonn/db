import { expect, test, vi } from "vitest";
import { main } from "./mutation-failure.ts";

const env = { GITHUB_REPOSITORY: "o/r", RUN_URL: "https://github.com/o/r/actions/runs/1" };

function fake(open: number[]) {
  const calls: { args: string[]; input?: string }[] = [];
  const gh = (args: string[], input?: string): string => {
    calls.push({ args, ...(input === undefined ? {} : { input }) });
    return args[1] === "list" ? JSON.stringify(open.map((number) => ({ number }))) : "";
  };
  return { calls, gh };
}

test("comments the run URL on the open report issue", () => {
  const { calls, gh } = fake([7]);
  main(env, gh);
  expect(calls).toHaveLength(2);
  expect(calls[1]?.args).toEqual(["issue", "comment", "7", "--repo", "o/r", "--body-file", "-"]);
  expect(calls[1]?.input).toContain(env.RUN_URL);
});

test("opens the report issue when none is open", () => {
  const { calls, gh } = fake([]);
  main(env, gh);
  expect(calls[1]?.args.slice(0, 2)).toEqual(["issue", "create"]);
  expect(calls[1]?.args).toContain("mutation-report");
  expect(calls[1]?.input).toContain(env.RUN_URL);
});

test("fails without the repository or run URL", () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const { calls, gh } = fake([]);
  const code = process.exitCode;
  main({ GITHUB_REPOSITORY: "o/r" }, gh);
  expect(process.exitCode).toBe(1);
  expect(calls).toEqual([]);
  process.exitCode = code;
  error.mockRestore();
});
