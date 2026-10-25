import { execFileSync } from "node:child_process";

/** Runs the step a refusal prints, the way a user pastes it: through a shell, in `cwd`. */
export function runPrintedStep(stderr: string, cwd: string): void {
  const step = /set them aside with (.+), then rerun rebase\n$/u.exec(stderr)?.[1];
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
