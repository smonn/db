import { join, sep } from "node:path";

type Project = { name: string; configFiles: string[] };

/** The repo's `.claude/worktrees/` folder, found from the repo root or from inside one of its worktrees. */
export function worktreesFolder(root: string): string {
  const marker = join(".claude", "worktrees");
  const at = root.indexOf(`${sep}${marker}${sep}`);
  return join(at === -1 ? root : root.slice(0, at), marker);
}

function isRecord(value: unknown): value is Record<string, unknown> {
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(listing);
  } catch {
    return [];
  }
  return Array.isArray(parsed) ? parsed.flatMap((entry) => toProject(entry)) : [];
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
