import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readChangedAdrs } from "./check-pr.ts";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn<typeof execFileSync>() }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn<typeof actual.readFileSync>(actual.readFileSync) };
});

const failShow = (letter: string, message: string): void => {
  vi.mocked(execFileSync)
    .mockReturnValueOnce(`${letter}\tdocs/adr/0003-new.md\n`)
    .mockImplementationOnce(() => {
      throw new Error(message);
    });
};

describe("readChangedAdrs", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "check-pr-"));
    mkdirSync(join(repo, "docs/adr"), { recursive: true });
    writeFileSync(join(repo, "docs/adr/0001-old.md"), "---\nstatus: accepted\n---\n");
    writeFileSync(join(repo, "docs/adr/0003-new.md"), "---\nstatus: proposed\n---\n");
    writeFileSync(join(repo, "docs/adr/TEMPLATE.md"), "---\nstatus: proposed\n---\n");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  test("lists the changed ADRs with their status and whether the PR adds them, and skips other files", () => {
    vi.mocked(execFileSync)
      .mockReturnValueOnce(
        "M\tdocs/adr/0001-old.md\nA\tdocs/adr/0003-new.md\nA\tdocs/adr/TEMPLATE.md\nM\tdocs/notes.md\n",
      )
      .mockReturnValueOnce("---\nstatus: proposed\n---\n");
    expect(readChangedAdrs("HEAD^1", repo)).toEqual([
      { file: "docs/adr/0001-old.md", status: "accepted", added: false, baseStatus: "proposed" },
      { file: "docs/adr/0003-new.md", status: "proposed", added: true },
    ]);
    expect(execFileSync).toHaveBeenCalledWith(
      "git",
      ["diff", "--name-status", "--no-renames", "--diff-filter=d", "HEAD^1", "HEAD"],
      { cwd: repo, encoding: "utf8" },
    );
    expect(execFileSync).toHaveBeenCalledWith("git", ["show", "HEAD^1:docs/adr/0001-old.md"], {
      cwd: repo,
      encoding: "utf8",
    });
    expect(execFileSync).toHaveBeenCalledTimes(2);
  });

  test("reads each ADR as UTF-8 text", () => {
    vi.mocked(execFileSync).mockReturnValueOnce("A\tdocs/adr/0003-new.md\n");
    readChangedAdrs("HEAD^1", repo);
    expect(readFileSync).toHaveBeenCalledWith(join(repo, "docs/adr/0003-new.md"), "utf8");
  });

  test("skips a path that only contains an ADR path", () => {
    vi.mocked(execFileSync).mockReturnValueOnce(
      "A\tx/docs/adr/0003-new.md\nA\tdocs/adr/0003-new.md.bak\nA\tdocs/adr/0003-gone.md.md/x\n\n",
    );
    expect(readChangedAdrs("HEAD^1", repo)).toEqual([]);
  });

  test.each([
    ["T", "fatal: path 'docs/adr/0003-new.md' exists on disk, but not in 'HEAD^1'"],
    ["M", "fatal: path 'docs/adr/0003-new.md' does not exist in 'HEAD^1'"],
  ])("counts a %s ADR missing from the base as added instead of crashing", (letter, message) => {
    failShow(letter, message);
    expect(readChangedAdrs("HEAD^1", repo)).toEqual([
      { file: "docs/adr/0003-new.md", status: "proposed", added: true },
    ]);
  });

  test("rethrows a git show failure that is not a missing path", () => {
    failShow("M", "fatal: bad object HEAD^1");
    expect(() => readChangedAdrs("HEAD^1", repo)).toThrow("bad object");
  });
});
