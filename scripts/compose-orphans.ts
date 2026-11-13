import { dirname, isAbsolute } from "node:path";

type Project = { name: string; configFiles: string[] };

/** The name prefix of every compose project `test-db.ts` creates. */
export const projectPrefix = "smonndb-";

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
 * Names the projects in `docker compose ls --format json` output that `test-db.ts` created
 * (their name has the `projectPrefix`) and whose worktree is gone: a worktree removed without
 * `stop` leaves its container running, wherever the worktree lived.
 *
 * `exists` is asked about the directory of each config file, not the file: a live worktree on a
 * branch without `compose.yaml`, or one whose compose file moved, keeps its database. The listing
 * joins the files with commas and does not escape a comma in a path, so a project counts as gone
 * only when every fragment is an absolute path; a fragment of a split path is usually relative.
 * A project without the prefix, with a live directory, or with a relative fragment is not one.
 */
export function orphanedProjects(listing: string, exists: (dir: string) => boolean): string[] {
  return parseListing(listing)
    .filter(
      ({ name, configFiles }) =>
        name.startsWith(projectPrefix) &&
        configFiles.every((file) => isAbsolute(file) && !exists(dirname(file))),
    )
    .map(({ name }) => name);
}
