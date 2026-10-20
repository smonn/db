import { globSync } from "node:fs";
import { basename } from "node:path";

export function markdownFiles(): string[] {
  return globSync("**/*.md", {
    exclude: (path) => ["node_modules", ".git", ".claude"].includes(basename(path)),
  }).sort();
}
