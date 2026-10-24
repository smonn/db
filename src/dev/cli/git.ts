import { execFile } from "node:child_process";
import { committedFilenames } from "../../runtime/internal/index.ts";
import type { MigrationSource } from "../../runtime/ports/index.ts";

function git(directory: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: directory, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error === null) resolve(stdout);
      else reject(new Error(`git ${args[0] ?? ""} failed: ${stderr.trim() || error.message}`));
    });
  });
}

/** The remote's default branch, such as `origin/main`, as `refs/remotes/origin/HEAD` names it. */
export async function defaultBaseRef(directory: string): Promise<string> {
  try {
    return (await git(directory, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).trim();
  } catch (error) {
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

async function resolveCommit(directory: string, ref: string): Promise<string> {
  try {
    const args = ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`];
    return (await git(directory, args)).trim();
  } catch (error) {
    throw new Error(`${ref} doesn't name a commit here; fetch it first`, { cause: error });
  }
}
