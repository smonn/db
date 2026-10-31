import { dirname, join, sep } from "node:path";

type Project = { name: string; configFiles: string[] };

/**
 * The main checkout's `.claude/worktrees/` folder. `gitCommonDir` is the absolute
 * `git rev-parse --git-common-dir` of `root`, which every worktree of a repo shares wherever the
 * worktree lives; without it (git failed) the folder is `root`'s own.
 */
export function worktreesFolder(root: string, gitCommonDir: string | undefined): string {
  return join(gitCommonDir === undefined ? root : dirname(gitCommonDir), ".claude", "worktrees");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  // Stryker disable next-line ConditionalExpression: 1 survivor: JSON.parse yields no undefined, and destructuring any other primitive gives undefined fields that toProject drops
  return typeof value === "object" && value !== null;
}

function toProject(entry: unknown): Project[] {
  if (!isRecord(entry)) return [];
  const { Name, ConfigFiles } = entry;
  return typeof Name === "string" && typeof ConfigFiles === "string"
    ? [{ name: Name, configFiles: ConfigFiles.split(",") }]
    : [];
}

function parseListing(listing: string): Project[] {
  return entries(listing).flatMap((entry) => toProject(entry));
}

function entries(listing: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(listing);
    // Stryker disable next-line ArrayDeclaration: 1 survivor: toProject drops a non-record entry, so a filler entry still yields no projects
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // Stryker disable next-line ArrayDeclaration: 1 survivor: toProject drops a non-record entry, so a filler entry still yields no projects
    return [];
  }
}

/**
 * Names the projects in `docker compose ls --format json` output whose config files all sat
 * under `worktrees` and are gone: a worktree removed without `stop` leaves its container
 * running. A project outside that folder, or with a config file that still exists, is not one.
 */
export function orphanedProjects(
  listing: string,
  worktrees: string,
  exists: (file: string) => boolean,
): string[] {
  return parseListing(listing)
    .filter(({ configFiles }) =>
      configFiles.every((file) => file.startsWith(`${worktrees}${sep}`) && !exists(file)),
    )
    .map(({ name }) => name);
}
