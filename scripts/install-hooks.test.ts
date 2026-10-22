import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { main } from "./install-hooks.ts";

let root: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function hooksPath(cwd: string): string {
  try {
    return git(cwd, "config", "core.hooksPath");
  } catch {
    return "";
  }
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "install-hooks-")));
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_SYSTEM", "/dev/null");
  vi.stubEnv("GIT_CEILING_DIRECTORIES", root);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

test("points core.hooksPath at .githooks in a git work tree", () => {
  git(root, "init", "--quiet");
  main(root);
  expect(hooksPath(root)).toBe(".githooks");
});

test("sets core.hooksPath from a linked worktree", () => {
  const repo = join(root, "repo");
  git(root, "init", "--quiet", "-b", "main", repo);
  git(
    repo,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.com",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "base",
  );
  git(repo, "worktree", "add", "--quiet", "-b", "side", join(root, "side"));
  main(join(root, "side"));
  expect(hooksPath(join(root, "side"))).toBe(".githooks");
});

test("does nothing outside a git work tree", () => {
  const plain = join(root, "plain");
  mkdirSync(plain);
  expect(() => {
    main(plain);
  }).not.toThrow();
  expect(hooksPath(plain)).toBe("");
});
