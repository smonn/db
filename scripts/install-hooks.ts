/**
 * Points git at the tracked hooks in `.githooks/` by setting `core.hooksPath`. A relative path
 * resolves against each worktree's root, so every worktree runs its own checkout's hooks. It
 * does nothing outside a git work tree, such as in an unpacked tarball.
 *
 * The `prepare` script runs it on every `pnpm install`; run it by hand with
 * `node scripts/install-hooks.ts`.
 */
import { spawnSync } from "node:child_process";

export function main(cwd: string = process.cwd()): void {
  const inside = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd,
    encoding: "utf8",
  });
  if (inside.status !== 0 || inside.stdout.trim() !== "true") return;
  const set = spawnSync("git", ["config", "core.hooksPath", ".githooks"], {
    cwd,
    encoding: "utf8",
  });
  if (set.status !== 0) throw new Error(`git config core.hooksPath failed: ${set.stderr.trim()}`);
}

if (import.meta.main) main();
