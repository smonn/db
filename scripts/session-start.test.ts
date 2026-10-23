import { execFileSync } from "node:child_process";
import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { main } from "./session-start.ts";

// A spawn that fails to start returns null output, which SpawnSyncReturns doesn't model.
type Result = { status: number | null; stdout: string | null; stderr: string | null };
type Spawn = (
  command: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => Result;

const mocks = vi.hoisted(() => ({
  pnpm: vi.fn<Spawn>(),
  failMerge: { value: false },
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const spawnSync: Spawn = (command, args, options) => {
    if (command === "pnpm") return mocks.pnpm(command, args, options);
    if (mocks.failMerge.value && args[0] === "merge") {
      return { status: 1, stdout: "", stderr: "merge blew up\n" };
    }
    return actual.spawnSync(command, args, options);
  };
  return { ...actual, spawnSync };
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

// Git hooks export GIT_DIR and GIT_INDEX_FILE, which would point every git call, ours and
// main()'s, at the real repository instead of the temp one.
function isolateGitEnv(): void {
  for (const name of Object.keys(process.env)) {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- stubEnv requires a value; undefined unsets.
    if (name.startsWith("GIT_")) vi.stubEnv(name, undefined);
  }
  vi.stubEnv("GIT_AUTHOR_NAME", "t");
  vi.stubEnv("GIT_AUTHOR_EMAIL", "t@example.com");
  vi.stubEnv("GIT_COMMITTER_NAME", "t");
  vi.stubEnv("GIT_COMMITTER_EMAIL", "t@example.com");
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_SYSTEM", "/dev/null");
}

function commit(cwd: string, file: string): void {
  writeFileSync(join(cwd, file), file);
  git(cwd, "add", file);
  git(cwd, "commit", "--quiet", "-m", file);
}

function output(): string[] {
  return vi.mocked(console.log).mock.calls.map(([line]) => String(line));
}

describe("main", () => {
  let root: string;
  let origin: string;
  let clone: string;

  function pushFromOrigin(file: string): void {
    commit(origin, file);
  }

  beforeEach(() => {
    isolateGitEnv();
    root = realpathSync(mkdtempSync(join(tmpdir(), "session-start-")));
    origin = join(root, "origin");
    clone = join(root, "clone");
    git(root, "init", "--quiet", "-b", "main", origin);
    commit(origin, "base.txt");
    git(root, "clone", "--quiet", origin, clone);
    mocks.pnpm.mockReset();
    mocks.pnpm.mockReturnValue({ status: 0, stdout: "", stderr: "" });
    mocks.failMerge.value = false;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  test("prints nothing when the branch is up to date, and installs from the lockfile", () => {
    main(clone);
    expect(output()).toEqual([]);
    expect(mocks.pnpm).toHaveBeenCalledWith(
      "pnpm",
      ["install", "--frozen-lockfile"],
      expect.objectContaining({ cwd: clone }),
    );
  });

  test("fast-forwards a clean branch that is behind", () => {
    pushFromOrigin("one.txt");
    pushFromOrigin("two.txt");
    main(clone);
    expect(output()).toEqual(["Fast-forwarded this branch by 2 commits to origin/main."]);
    expect(readFileSync(join(clone, "two.txt"), "utf8")).toBe("two.txt");
  });

  test("reports a behind branch that has commits of its own", () => {
    pushFromOrigin("one.txt");
    commit(clone, "mine.txt");
    const head = git(clone, "rev-parse", "HEAD");
    main(clone);
    expect(output()).toEqual([
      "This branch is 1 commit behind origin/main and has 1 commit of its own, so it was not fast-forwarded. Branch new work from origin/main.",
    ]);
    expect(git(clone, "rev-parse", "HEAD")).toBe(head);
  });

  test("reports a behind branch that has uncommitted changes", () => {
    pushFromOrigin("one.txt");
    writeFileSync(join(clone, "base.txt"), "edited");
    main(clone);
    expect(output()).toEqual([
      "This branch is 1 commit behind origin/main and has uncommitted changes, so it was not fast-forwarded. Branch new work from origin/main.",
    ]);
  });

  test("reports a failed fast-forward with git's message", () => {
    pushFromOrigin("one.txt");
    mocks.failMerge.value = true;
    main(clone);
    expect(output()).toEqual(["Fast-forward to origin/main failed:\nmerge blew up"]);
  });

  test("says so when origin/main cannot be fetched, and still installs", () => {
    git(clone, "remote", "remove", "origin");
    main(clone);
    expect(output()).toEqual(["Could not fetch origin/main; the branch may be behind it."]);
    expect(mocks.pnpm).toHaveBeenCalledTimes(1);
  });

  test("prints the last ten lines of a failed install", () => {
    const lines = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
    mocks.pnpm.mockReturnValue({ status: 1, stdout: lines.join("\n"), stderr: "" });
    main(clone);
    expect(output()).toEqual([`pnpm install failed:\n${lines.slice(-10).join("\n")}`]);
  });

  test("treats a pnpm that cannot start as a failed install", () => {
    mocks.pnpm.mockReturnValue({ status: null, stdout: null, stderr: null });
    main(clone);
    expect(output()).toEqual(["pnpm install failed:\n"]);
  });

  test("defaults to the working directory", () => {
    vi.spyOn(process, "cwd").mockReturnValue(clone);
    main();
    expect(mocks.pnpm).toHaveBeenCalledWith(
      "pnpm",
      ["install", "--frozen-lockfile"],
      expect.objectContaining({ cwd: clone }),
    );
  });
});
