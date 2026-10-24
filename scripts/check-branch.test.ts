import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { main } from "./check-branch.ts";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn<typeof spawnSync>() }));

const spawn = vi.mocked(spawnSync);
const result: SpawnSyncReturns<string> = {
  pid: 0,
  output: [],
  stdout: "",
  stderr: "",
  status: 0,
  signal: null,
};

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("main with an injected branch", () => {
  test("passes a Conventional Branch", () => {
    main(() => "chore/pre-push-branch-check");
    expect(console.error).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  test("fails a branch the CI rule rejects", () => {
    main(() => "docs/config-and-cli");
    expect(console.error).toHaveBeenCalledWith(
      'Branch "docs/config-and-cli" is not a Conventional Branch: feature|bugfix|hotfix|release|chore/<lowercase-kebab>',
    );
    expect(process.exitCode).toBe(1);
  });

  test("passes a detached HEAD, which has no branch name", () => {
    main(() => "");
    expect(console.error).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });
});

describe("main reading git", () => {
  test("asks git for the current branch and checks it", () => {
    spawn.mockReturnValue({ ...result, stdout: "docs/x\n" });
    main();
    expect(spawn).toHaveBeenCalledWith("git", ["branch", "--show-current"], { encoding: "utf8" });
    expect(process.exitCode).toBe(1);
  });

  test("treats empty git output as a detached HEAD", () => {
    spawn.mockReturnValue({ ...result, stdout: "\n" });
    main();
    expect(process.exitCode).toBeUndefined();
  });

  test("throws when git fails", () => {
    spawn.mockReturnValue({ ...result, status: 128, stderr: "fatal: not a git repository" });
    expect(() => {
      main();
    }).toThrow("git branch --show-current failed: fatal: not a git repository");
  });
});
