import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { join } from "node:path";
import { type Mock, vi } from "vitest";

export type Result = { status: number | null; stdout: string; stderr: string };
export type Spawn = (
  command: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => Result;

// What `test-db.ts` runs: `git` and `docker` each get their own mock.
export const docker: Mock<Spawn> = vi.fn<Spawn>();
export const git: Mock<Spawn> = vi.fn<Spawn>();

export function routeSpawn<T extends { spawnSync: unknown }>(actual: T): T {
  return {
    ...actual,
    spawnSync: (...args: Parameters<Spawn>) => (args[0] === "git" ? git : docker)(...args),
  };
}

export function ok(stdout = ""): Result {
  return { status: 0, stdout, stderr: "" };
}

export function fail(stderr: string): Result {
  return { status: 1, stdout: "", stderr };
}

// `docker compose ls --all --format json` lists each project's config files, comma-separated.
export function listing(...projects: { name: string; files: string[] }[]): Result {
  return ok(
    JSON.stringify(
      projects.map(({ name, files }) => ({
        Name: name,
        Status: "running(1)",
        ConfigFiles: files.join(","),
      })),
    ),
  );
}

export function worktreeFile(root: string, worktree: string): string {
  return join(root, ".claude", "worktrees", worktree, "compose.yaml");
}
