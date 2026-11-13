import { execFileSync } from "node:child_process";

/** What a refusal's hint says about getting the stashed files back. */
export const RESTORE_HINT =
  "Afterwards run git stash pop from the repository root to restore them; if pop stops at a file rebase wrote, git keeps the stash: move that file aside, pop again, and merge the two by hand";

/** Runs the step a refusal prints, the way a user pastes it: through a shell, in `cwd`. */
export function runPrintedStep(stderr: string, cwd: string): void {
  const step = /set them aside with (.+?), then rerun rebase\. /u.exec(stderr)?.[1];
  if (step === undefined) throw new Error(`no step in: ${stderr}`);
  // A stash is a commit, so git needs an identity.
  const identity = { NAME: "test", EMAIL: "test@example.com" };
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: identity.NAME,
    GIT_AUTHOR_EMAIL: identity.EMAIL,
    GIT_COMMITTER_NAME: identity.NAME,
    GIT_COMMITTER_EMAIL: identity.EMAIL,
  };
  execFileSync("sh", ["-c", step], { cwd, env, encoding: "utf8" });
}
