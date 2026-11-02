import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { type Mock, vi } from "vitest";

export type Result = { status: number | null; stdout: string; stderr: string };
export type Spawn = (
  command: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => Result;

// What `test-db.ts` runs: `docker`.
export const docker: Mock<Spawn> = vi.fn<Spawn>();

export function routeSpawn<T extends { spawnSync: unknown }>(actual: T): T {
  return { ...actual, spawnSync: docker };
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
