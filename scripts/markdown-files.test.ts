import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { markdownFiles } from "./markdown-files.ts";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "markdown-files-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function touch(...paths: string[]): void {
  for (const path of paths) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), "");
  }
}

describe("markdownFiles", () => {
  test("lists Markdown files relative to the directory, sorted", () => {
    touch("b.md", "docs/a.md", "README.md", "notes.txt");
    expect(markdownFiles(root)).toEqual(["README.md", "b.md", "docs/a.md"]);
  });

  test("skips node_modules, .git, and .claude", () => {
    touch("a.md", "node_modules/x/readme.md", ".git/info.md", ".claude/worktrees/w/a.md");
    expect(markdownFiles(root)).toEqual(["a.md"]);
  });

  test("skips the CHANGELOG.md that release-please writes", () => {
    touch("a.md", "CHANGELOG.md");
    expect(markdownFiles(root)).toEqual(["a.md"]);
  });

  test("defaults to the working directory", () => {
    expect(markdownFiles()).toContain("AGENTS.md");
  });
});
