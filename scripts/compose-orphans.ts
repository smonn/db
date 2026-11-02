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
 * (their name has the `projectPrefix`) and whose config files are all gone: a worktree removed
 * without `stop` leaves its container running, wherever the worktree lived. A project with a
 * config file that still exists, or without the prefix, is not one.
 */
export function orphanedProjects(listing: string, exists: (file: string) => boolean): string[] {
  return parseListing(listing)
    .filter(
      ({ name, configFiles }) =>
        name.startsWith(projectPrefix) && configFiles.every((file) => file !== "" && !exists(file)),
    )
    .map(({ name }) => name);
}
