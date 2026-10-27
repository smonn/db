/**
 * Lists the repo's Markdown files relative to the working directory, sorted, skipping
 * `node_modules` and `CHANGELOG.md`, which release-please writes from PR titles. The glob already
 * skips folders that start with a dot, such as `.git` and `.claude` (agent worktrees). Shared by the
 * check scripts.
 */
import { globSync } from "node:fs";
import { basename } from "node:path";

const skipped = new Set(["node_modules", "CHANGELOG.md"]);

export function markdownFiles(cwd: string = process.cwd()): string[] {
  return globSync("**/*.md", {
    cwd,
    exclude: (path) => skipped.has(basename(path)),
  }).toSorted();
}
