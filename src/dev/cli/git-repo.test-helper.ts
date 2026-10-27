import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import { isolateGitEnv } from "./git-env.test-helper.ts";

export type GitRepo = {
  /** A fresh repository on `main` for each test, removed after it. */
  readonly dir: string;
  /** Runs git in the repository with signing and hooks off. */
  git(...args: string[]): string;
  /** Writes `content` to `path` under the repository, creating its folders. */
  write(path: string, content: string): Promise<void>;
};

/** Gives each test in the file an empty repository, with `GIT_*` isolated from the caller's. */
export function useGitRepo(): GitRepo {
  let dir: string;

  const git = (...args: string[]): string =>
    execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
      cwd: dir,
      encoding: "utf8",
    });

  beforeEach(async () => {
    isolateGitEnv();
    dir = await mkdtemp(join(tmpdir(), "smonn-db-git-"));
    git("init", "-q", "-b", "main");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  return {
    get dir() {
      return dir;
    },
    git,
    write: async (path, content) => {
      await mkdir(join(dir, path, ".."), { recursive: true });
      await writeFile(join(dir, path), content);
    },
  };
}

/** Rejects unless `promise` rejects with an Error, and returns it. */
export async function failure(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(
    () => {},
    (caught: unknown) => caught,
  );
  if (!(error instanceof Error)) throw new Error("expected the promise to reject with an Error");
  return error;
}

/** Runs `fn` in a fresh directory that no git repository contains. */
export async function outsideAnyRepository<T>(fn: (outside: string) => Promise<T>): Promise<T> {
  const outside = await mkdtemp(join(tmpdir(), "smonn-db-nogit-"));
  try {
    return await fn(outside);
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
}
