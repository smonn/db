import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, vi } from "vitest";

export type CliProject = {
  /** A fresh temp directory for each test, removed after it. */
  readonly dir: string;
  /** Everything the test's `main` call wrote to stderr. */
  readonly stderr: string;
};

/** Gives each test in the file a temp project directory and captures stderr. */
export function useCliProject(): CliProject {
  let dir: string;
  let stderr: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "smonn-db-cli-"));
    stderr = "";
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr += String(chunk);
      return true;
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  return {
    get dir() {
      return dir;
    },
    get stderr() {
      return stderr;
    },
  };
}
