import { execFileSync } from "node:child_process";
import type { SpawnSyncOptions } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { main, prePushChecks, preCommitChecks } from "./git-hooks.ts";

type Spawn = (command: string, args: string[], options: SpawnSyncOptions) => { status: number };

const mocks = vi.hoisted(() => ({ pnpm: vi.fn<Spawn>() }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const spawnSync = (command: string, args: string[], options: SpawnSyncOptions) =>
    command === "pnpm"
      ? mocks.pnpm(command, args, options)
      : actual.spawnSync(command, args, options);
  return { ...actual, spawnSync };
});

let root: string;

function git(...args: string[]): void {
  execFileSync("git", args, {
    cwd: root,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  });
}

function stage(file: string): void {
  writeFileSync(join(root, file), file);
  git("add", file);
}

function ranArgs(): string[][] {
  return mocks.pnpm.mock.calls.map(([, args]) => args);
}

function errors(): string[] {
  return vi.mocked(console.error).mock.calls.map(([line]) => String(line));
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "git-hooks-")));
  git("init", "--quiet");
  mocks.pnpm.mockReset();
  mocks.pnpm.mockReturnValue({ status: 0 });
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
  process.exitCode = undefined;
});

describe("pre-commit", () => {
  test("checks formatting and lint on the staged files only", () => {
    stage("a.ts");
    stage("b.md");
    writeFileSync(join(root, "unstaged.ts"), "");
    main("pre-commit", root);
    expect(ranArgs()).toEqual([
      ["exec", "oxfmt", "--check", "--no-error-on-unmatched-pattern", "a.ts", "b.md"],
      ["exec", "oxlint", "--no-error-on-unmatched-pattern", "a.ts", "b.md"],
    ]);
    expect(mocks.pnpm).toHaveBeenCalledWith(
      "pnpm",
      expect.anything(),
      expect.objectContaining({ cwd: root, stdio: "inherit" }),
    );
    expect(process.exitCode).toBeUndefined();
  });

  test("skips a staged deletion", () => {
    stage("gone.ts");
    git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "x");
    git("rm", "--quiet", "gone.ts");
    main("pre-commit", root);
    expect(mocks.pnpm).not.toHaveBeenCalled();
  });

  test("runs nothing when nothing is staged", () => {
    expect(preCommitChecks([])).toEqual([]);
  });

  test("runs lint after a formatting failure and names the fix for each", () => {
    stage("a.ts");
    mocks.pnpm.mockReturnValue({ status: 1 });
    main("pre-commit", root);
    expect(mocks.pnpm).toHaveBeenCalledTimes(2);
    expect(errors()).toEqual([
      "oxfmt failed. Run `pnpm format`, then stage the result.",
      "oxlint failed. Fix the errors it lists.",
    ]);
    expect(process.exitCode).toBe(1);
  });
});

describe("pre-push", () => {
  test("runs typecheck and knip", () => {
    main("pre-push", root);
    expect(ranArgs()).toEqual(prePushChecks.map((check) => check.args));
    expect(ranArgs()).toEqual([
      ["run", "typecheck"],
      ["run", "knip"],
    ]);
    expect(process.exitCode).toBeUndefined();
  });

  test("fails when one check fails, after running both", () => {
    mocks.pnpm.mockReturnValueOnce({ status: 2 }).mockReturnValueOnce({ status: 0 });
    main("pre-push", root);
    expect(mocks.pnpm).toHaveBeenCalledTimes(2);
    expect(errors()).toEqual(["typecheck failed. Fix the errors it lists."]);
    expect(process.exitCode).toBe(1);
  });
});

test("refuses an unknown hook by name", () => {
  expect(() => {
    main("post-merge", root);
  }).toThrow('Unknown hook "post-merge"');
});

test("reports a git failure outside a repository", () => {
  rmSync(join(root, ".git"), { recursive: true });
  vi.stubEnv("GIT_CEILING_DIRECTORIES", root);
  expect(() => {
    main("pre-commit", root);
  }).toThrow("git diff --cached failed");
  vi.unstubAllEnvs();
});
