import { execFile } from "node:child_process";
import { committedFilenames } from "../../runtime/internal/index.ts";
import type { MigrationSource } from "../../runtime/ports/index.ts";

/** Git exited 1, which a `--quiet` lookup uses for a ref that doesn't exist. */
class NotFound extends Error {}

function git(directory: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: directory, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error === null) {
        resolve(stdout);
        return;
      }
      if (error.code === "ENOENT") {
        reject(new Error("can't run git: it isn't installed or isn't on PATH", { cause: error }));
        return;
      }
      const message = `git ${args[0] ?? ""} failed: ${stderr.trim() || error.message}`;
      reject(error.code === 1 ? new NotFound(message, { cause: error }) : new Error(message));
    });
  });
}

/** The remote's default branch, such as `origin/main`, as `refs/remotes/origin/HEAD` names it. */
export async function defaultBaseRef(directory: string): Promise<string> {
  try {
    const args = ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"];
    return (await git(directory, args)).trim();
  } catch (error) {
    if (!(error instanceof NotFound)) throw error;
    throw new Error(
      "can't find the remote's default branch: pass --onto <ref>, or run git remote set-head origin --auto",
      { cause: error },
    );
  }
}

/**
 * The Committed migrations in `directory` as the commit `ref` names them, read from git's object
 * store rather than the working tree. A folder the commit lacks holds no migrations.
 */
export function gitMigrationSource(directory: string, ref: string): MigrationSource {
  return {
    list: async () => {
      const commit = await resolveCommit(directory, ref);
      const blobs = new Map<string, string>();
      for (const entry of (await git(directory, ["ls-tree", "-z", commit, "--", "."])).split(
        "\0",
      )) {
        const [meta = "", name = ""] = entry.split("\t");
        blobs.set(name, meta.split(" ")[2] ?? "");
      }
      return Promise.all(
        committedFilenames([...blobs.keys()])
          .toSorted()
          .map(async (filename) => ({
            filename,
            content: await git(directory, ["cat-file", "blob", blobs.get(filename) ?? ""]),
          })),
      );
    },
  };
}

/** The paths under `directory`, relative to it, that differ from the last commit or aren't tracked. */
export async function uncommittedPaths(directory: string): Promise<string[]> {
  const prefix = (await git(directory, ["rev-parse", "--show-prefix"])).trim();
  const args = ["status", "--porcelain", "-z", "--untracked-files=all", "--no-renames", "--", "."];
  return (await git(directory, args))
    .split("\0")
    .filter((entry) => entry !== "")
    .map((entry) => entry.slice("XY ".length + prefix.length));
}

async function resolveCommit(directory: string, ref: string): Promise<string> {
  try {
    // rev-parse takes --end-of-options from git 2.30: https://github.com/git/git/blob/master/Documentation/RelNotes/2.30.0.adoc
    const args = ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`];
    return (await git(directory, args)).trim();
  } catch (error) {
    if (!(error instanceof NotFound)) throw error;
    throw new Error(`${ref} doesn't name a commit here; fetch it first`, { cause: error });
  }
}
