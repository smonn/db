/**
 * Lists the repo's Markdown files relative to the working directory, sorted, skipping
 * `node_modules`, `.git`, and `.claude` (agent worktrees). Shared by the check scripts.
 */
import { globSync } from "node:fs";
import { basename } from "node:path";

export function markdownFiles(): string[] {
  return globSync("**/*.md", {
    exclude: (path) => ["node_modules", ".git", ".claude"].includes(basename(path)),
  }).toSorted();
}
