import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { main, projectName } from "./test-db.ts";
import { docker, fail, git, listing, ok, worktreeFile } from "./test-db.test-helper.ts";

vi.mock("node:child_process", async (importOriginal) =>
  (await import("./test-db.test-helper.ts")).routeSpawn(
    await importOriginal<typeof import("node:child_process")>(),
  ),
);

function calls(): string[] {
  return docker.mock.calls.map(([command, args]) => [command, ...args].join(" "));
}

function downs(): string[] {
  return calls().filter((call) => call.endsWith(" down --volumes"));
}

describe("main's orphaned projects", () => {
  let root: string;
  let name: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "test-db-")));
    name = projectName(root);
    docker.mockReset();
    git.mockReset();
    git.mockImplementation(() => ok(`${join(root, ".git")}\n`));
    vi.spyOn(console, "log").mockImplementation(() => {});
    mkdirSync(join(root, ".claude", "worktrees", "live"), { recursive: true });
    writeFileSync(worktreeFile(root, "live"), "");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  test("takes down a project whose worktree is gone before starting", () => {
    docker
      .mockReturnValueOnce(listing({ name: "t71", files: [worktreeFile(root, "gone")] }))
      .mockReturnValueOnce(ok())
      .mockReturnValueOnce(ok("0.0.0.0:32768\n"));

    main([], root);

    expect(calls()).toEqual([
      "docker compose ls --all --format json",
      "docker compose -p t71 down --volumes",
      `docker compose -p ${name} port postgres 5432`,
    ]);
    expect(docker.mock.calls[1]?.[2].cwd).toBe(root);
    expect(console.log).toHaveBeenCalledWith("Removed t71, whose worktree is gone");
  });

  test("sweeps the main checkout's folder when the worktree lives outside the repo", () => {
    const mainCheckout = join("/code", "db");
    git.mockReturnValueOnce(ok(`${join(mainCheckout, ".git")}\n`));
    docker
      .mockReturnValueOnce(
        listing(
          { name: "t71", files: [worktreeFile(mainCheckout, "gone")] },
          { name: "inside-root", files: [worktreeFile(root, "gone")] },
        ),
      )
      .mockReturnValueOnce(ok())
      .mockReturnValueOnce(ok("0.0.0.0:32768\n"));

    main([], root);

    expect(git).toHaveBeenCalledWith(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      expect.objectContaining({ cwd: root, encoding: "utf8" }),
    );
    expect(downs()).toEqual(["docker compose -p t71 down --volumes"]);
  });

  test.each([
    ["git fails", { status: 128, stdout: "/stray/.git\n", stderr: "fatal: not a git repository" }],
    ["git prints nothing", ok("\n")],
  ])("sweeps the root's own folder when %s", (_, result) => {
    git.mockReset();
    git.mockReturnValue(result);
    docker
      .mockReturnValueOnce(listing({ name: "t71", files: [worktreeFile(root, "gone")] }))
      .mockReturnValueOnce(ok())
      .mockReturnValueOnce(ok("0.0.0.0:32768\n"));

    main([], root);

    expect(downs()).toEqual(["docker compose -p t71 down --volumes"]);
  });

  test("leaves projects whose config file exists or is outside the worktrees folder", () => {
    docker
      .mockReturnValueOnce(
        listing(
          { name: "live", files: [worktreeFile(root, "live")] },
          { name: "elsewhere", files: [join(root, "other", "compose.yaml")] },
        ),
      )
      .mockReturnValueOnce(ok("0.0.0.0:32768\n"));

    main([], root);

    expect(downs()).toEqual([]);
  });

  test("warns about a project it can't take down and goes on", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    docker
      .mockReturnValueOnce(listing({ name: "t71", files: [worktreeFile(root, "gone")] }))
      .mockReturnValueOnce(fail("in use\n"))
      .mockReturnValueOnce(ok("0.0.0.0:32768\n"));

    main([], root);

    expect(console.warn).toHaveBeenCalledWith("Could not remove t71:\nin use");
    expect(readFileSync(join(root, ".env.test"), "utf8")).toContain("localhost:32768/");
  });
});
