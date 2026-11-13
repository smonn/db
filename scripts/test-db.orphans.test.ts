import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { main, projectName } from "./test-db.ts";
import { docker, fail, listing, ok } from "./test-db.test-helper.ts";

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
  let live: string;
  let gone: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "test-db-")));
    name = projectName(root);
    docker.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
    mkdirSync(join(root, "live"));
    live = join(root, "live", "compose.yaml");
    gone = join(root, "gone", "compose.yaml");
    writeFileSync(live, "");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  test("takes down a prefixed project whose config file is gone before starting", () => {
    docker
      .mockReturnValueOnce(listing({ name: "smonndb-t3-1a2b", files: [gone] }))
      .mockReturnValueOnce(ok())
      .mockReturnValueOnce(ok("0.0.0.0:32768\n"));

    main([], root);

    expect(calls()).toEqual([
      "docker compose ls --all --format json",
      "docker compose -p smonndb-t3-1a2b down --volumes",
      `docker compose -p ${name} port postgres 5432`,
    ]);
    expect(docker.mock.calls[0]?.[2]).toMatchObject({ encoding: "utf8", cwd: root });
    expect(docker.mock.calls[1]?.[2].cwd).toBe(root);
    expect(console.log).toHaveBeenCalledWith("Removed smonndb-t3-1a2b, whose worktree is gone");
  });

  test("leaves projects whose worktree directory exists or whose name lacks the prefix", () => {
    docker
      .mockReturnValueOnce(
        listing(
          { name: "smonndb-live", files: [live] },
          { name: "smonndb-no-compose", files: [join(root, "live", "missing.yaml")] },
          { name: "elsewhere", files: [gone] },
        ),
      )
      .mockReturnValueOnce(ok("0.0.0.0:32768\n"));

    main([], root);

    expect(downs()).toEqual([]);
  });

  test("warns about a project it can't take down and goes on", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    docker
      .mockReturnValueOnce(listing({ name: "smonndb-t3-1a2b", files: [gone] }))
      .mockReturnValueOnce(fail("in use\n"))
      .mockReturnValueOnce(ok("0.0.0.0:32768\n"));

    main([], root);

    expect(console.warn).toHaveBeenCalledWith("Could not remove smonndb-t3-1a2b:\nin use");
    expect(readFileSync(join(root, ".env.test"), "utf8")).toContain("localhost:32768/");
  });
});
