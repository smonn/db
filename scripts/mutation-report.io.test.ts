import { beforeEach, expect, test, vi } from "vitest";

const { execFileSync, readFileSync } = vi.hoisted(() => ({
  execFileSync: vi.fn<(...args: unknown[]) => string>(),
  readFileSync: vi.fn<(...args: unknown[]) => string>(),
}));

vi.mock("node:child_process", () => ({ execFileSync }));
vi.mock("node:fs", () => ({ readFileSync }));

const { main, runGh } = await import("./mutation-report.ts");

beforeEach(() => {
  vi.resetAllMocks();
});

test("runGh runs gh with the arguments and no input", () => {
  execFileSync.mockReturnValue("out");
  expect(runGh(["issue", "list"])).toBe("out");
  expect(execFileSync.mock.calls).toStrictEqual([["gh", ["issue", "list"], { encoding: "utf8" }]]);
});

test("runGh passes the input to gh", () => {
  runGh(["issue", "edit"], "body");
  expect(execFileSync).toHaveBeenCalledWith("gh", ["issue", "edit"], {
    encoding: "utf8",
    input: "body",
  });
});

test("main reads Stryker's report when given no paths", () => {
  readFileSync.mockReturnValue(JSON.stringify({ files: {} }));
  const gh = vi.fn<(args: string[], input?: string) => string>(() => "[]");
  main([], { GITHUB_REPOSITORY: "smonn/db" }, gh);
  expect(readFileSync).toHaveBeenCalledExactlyOnceWith("reports/mutation/mutation.json", "utf8");
});

test("main reads each report it is given as UTF-8", () => {
  readFileSync.mockReturnValue(JSON.stringify({ files: {} }));
  const gh = vi.fn<(args: string[], input?: string) => string>(() => "[]");
  main(["a.json", "b.json"], { GITHUB_REPOSITORY: "smonn/db" }, gh);
  expect(readFileSync.mock.calls).toEqual([
    ["a.json", "utf8"],
    ["b.json", "utf8"],
  ]);
});
