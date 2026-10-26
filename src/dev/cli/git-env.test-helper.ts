import { vi } from "vitest";

/**
 * Stubs every `GIT_*` variable to undefined, then sets a test identity and ignores the global and
 * system config; undo it with `vi.unstubAllEnvs()`. A git hook, such as a pre-push hook in a
 * linked worktree, exports `GIT_DIR`, which overrides `cwd` and would point every git call a test
 * makes, and those of the code it tests, at the pushing repository (#539). `smonn/real-git-env`
 * requires it in any test that spawns `git`.
 */
export function isolateGitEnv(): void {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("GIT_")) vi.stubEnv(name, undefined);
  }
  vi.stubEnv("GIT_AUTHOR_NAME", "t");
  vi.stubEnv("GIT_AUTHOR_EMAIL", "t@example.com");
  vi.stubEnv("GIT_COMMITTER_NAME", "t");
  vi.stubEnv("GIT_COMMITTER_EMAIL", "t@example.com");
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_SYSTEM", "/dev/null");
}
