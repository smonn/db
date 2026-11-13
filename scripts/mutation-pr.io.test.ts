import { beforeEach, expect, test, vi } from "vitest";

const { execFileSync, appendFileSync, readFileSync, mutatedFiles } = vi.hoisted(() => ({
  execFileSync: vi.fn<(...args: unknown[]) => string>(),
  appendFileSync: vi.fn<(...args: unknown[]) => void>(),
  readFileSync: vi.fn<(...args: unknown[]) => string>(),
  mutatedFiles: vi.fn<(...args: unknown[]) => string[]>(),
}));

vi.mock("node:child_process", () => ({ execFileSync }));
vi.mock("node:fs", () => ({ appendFileSync, readFileSync }));
vi.mock("./mark-stryker-disables.ts", () => ({ mutatedFiles }));

const { realDeps } = await import("./mutation-pr.ts");

beforeEach(() => {
  vi.resetAllMocks();
});

test("git runs git and returns its output as text", () => {
  execFileSync.mockReturnValue("out");
  expect(realDeps({}).git(["diff"])).toBe("out");
  expect(execFileSync).toHaveBeenCalledExactlyOnceWith("git", ["diff"], { encoding: "utf8" });
});

test("stryker runs the local binary on the files with its output passed through", () => {
  realDeps({}).stryker(["a.ts", "b.ts"]);
  expect(execFileSync).toHaveBeenCalledExactlyOnceWith(
    "node_modules/.bin/stryker",
    ["run", "--mutate", "a.ts,b.ts"],
    { stdio: "inherit" },
  );
});

test("mutable expands every mutate glob from the working directory", () => {
  mutatedFiles.mockReturnValue(["src/a.ts"]);
  expect(realDeps({}).mutable()).toEqual(["src/a.ts"]);
  expect(mutatedFiles.mock.calls[0]?.[1]).toBe(process.cwd());
  expect(mutatedFiles.mock.calls[0]?.[0]).toContain("scripts/**/*.ts");
  expect(mutatedFiles.mock.calls[0]?.[0]).toContain("src/runtime/**/*.ts");
});

test("report parses Stryker's JSON report", () => {
  readFileSync.mockReturnValue('{"files":{}}');
  expect(realDeps({}).report()).toEqual({ files: {} });
  expect(readFileSync).toHaveBeenCalledExactlyOnceWith("reports/mutation/mutation.json", "utf8");
});

test("now reads the clock", () => {
  expect(Math.abs(realDeps({}).now() - Date.now())).toBeLessThan(1000);
});

test("write appends to the job summary file", () => {
  realDeps({ GITHUB_STEP_SUMMARY: "/tmp/summary.md" }).write("text");
  expect(appendFileSync).toHaveBeenCalledExactlyOnceWith("/tmp/summary.md", "text");
});

test("write prints to stdout when no summary file is set, also when it is empty", () => {
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  realDeps({}).write("one");
  realDeps({ GITHUB_STEP_SUMMARY: "" }).write("two");
  expect(stdout.mock.calls).toEqual([["one"], ["two"]]);
  expect(appendFileSync).not.toHaveBeenCalled();
  stdout.mockRestore();
});
