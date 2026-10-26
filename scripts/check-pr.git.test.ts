import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolateGitEnv } from "../src/dev/cli/git-env.test-helper.ts";
import { readChangedAdrs } from "./check-pr.ts";

// Real git against a temp repo; any other command (such as gh) is refused.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const guarded = (
    command: string,
    args: readonly string[],
    options: ExecFileSyncOptionsWithStringEncoding,
  ): string => {
    if (command !== "git") throw new Error(`Only git may run here, not ${command}`);
    return actual.execFileSync(command, args, options);
  };
  return { ...actual, execFileSync: guarded };
});

const adr = (status: string): string => `---\nstatus: ${status}\n---\n\n# Decision\n`;

describe("readChangedAdrs against a real git repository", () => {
  let dir: string;

  const git = (...args: string[]): string =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd: dir, encoding: "utf8" },
    ).trim();

  const commit = (message: string): string => {
    git("add", "-A");
    git("commit", "--quiet", "-m", message);
    return git("rev-parse", "HEAD");
  };

  beforeEach(() => {
    isolateGitEnv();
    dir = mkdtempSync(join(tmpdir(), "check-pr-git-"));
    git("init", "--quiet");
    mkdirSync(join(dir, "docs", "adr"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  test("reads the base status of a modified ADR and none for an added one", () => {
    writeFileSync(join(dir, "docs", "adr", "0001-first.md"), adr("proposed"));
    const base = commit("base");
    writeFileSync(join(dir, "docs", "adr", "0001-first.md"), adr("accepted"));
    writeFileSync(join(dir, "docs", "adr", "0002-second.md"), adr("proposed"));
    commit("change");

    expect(readChangedAdrs(base, dir)).toEqual([
      { file: "docs/adr/0001-first.md", status: "accepted", added: false, baseStatus: "proposed" },
      { file: "docs/adr/0002-second.md", status: "proposed", added: true },
    ]);
  });
});
