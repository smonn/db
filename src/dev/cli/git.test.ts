import { describe, expect, it, vi } from "vitest";
import { failure, outsideAnyRepository, useGitRepo } from "./git-repo.test-helper.ts";
import { defaultBaseRef } from "./git.ts";

const repo = useGitRepo();

function causeOf(error: Error): Error {
  if (!(error.cause instanceof Error)) throw new Error(`${error.message} has no Error cause`);
  return error.cause;
}

describe("defaultBaseRef", () => {
  it("names the branch refs/remotes/origin/HEAD points at", async () => {
    repo.git("commit", "-q", "--allow-empty", "-m", "root");
    repo.git("update-ref", "refs/remotes/origin/main", "main");
    repo.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");

    expect(await defaultBaseRef(repo.dir)).toBe("origin/main");
  });

  it("tells the user how to name the base when the remote has no default branch", async () => {
    const error = await failure(defaultBaseRef(repo.dir));

    expect(error.message).toBe(
      "can't find the remote's default branch: pass --onto <ref>, or run git remote set-head origin --auto",
    );
    const notFound = causeOf(error);
    expect(notFound.message).toMatch(/^git symbolic-ref failed/u);
    expect(causeOf(notFound)).toBeInstanceOf(Error);
  });

  it("passes on a git failure that isn't a missing ref", async () => {
    const error = await outsideAnyRepository((outside) => failure(defaultBaseRef(outside)));

    expect(error.message).toMatch(/^git symbolic-ref failed: .*not a git repository/u);
  });

  it("explains a git that isn't on PATH, keeping the cause", async () => {
    vi.stubEnv("PATH", repo.dir);

    const error = await failure(defaultBaseRef(repo.dir));

    expect(error.message).toBe("can't run git: it isn't installed or isn't on PATH");
    expect(error.cause).toMatchObject({ code: "ENOENT" });
  });
});
