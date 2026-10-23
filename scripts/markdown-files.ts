/**
 * Lists the repo's Markdown files relative to the working directory, sorted, skipping
 * `node_modules`, `.git`, `.claude` (agent worktrees), and `CHANGELOG.md`, which release-please
 * writes from PR titles. Shared by the check scripts.
 */
import { globSync } from "node:fs";
import { basename } from "node:path";

const skipped = new Set(["node_modules", ".git", ".claude", "CHANGELOG.md"]);

export function markdownFiles(cwd = "."): string[] {
  return globSync("**/*.md", {
    cwd,
    exclude: (path) => skipped.has(basename(path)),
  }).toSorted();
}
