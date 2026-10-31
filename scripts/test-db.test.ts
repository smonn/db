import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { main, parsePort, projectName } from "./test-db.ts";

type Result = { status: number | null; stdout: string; stderr: string };
type Spawn = (
  command: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => Result;

const docker = vi.hoisted(() => vi.fn<Spawn>());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: docker };
});

const ok = (stdout = ""): Result => ({ status: 0, stdout, stderr: "" });
const fail = (stderr: string): Result => ({ status: 1, stdout: "", stderr });
const noProjects = ok("[]");

// `docker compose ls --all --format json` lists each project's config files, comma-separated.
function listing(...projects: { name: string; files: string[] }[]): Result {
  return ok(
    JSON.stringify(
      projects.map(({ name, files }) => ({
        Name: name,
        Status: "running(1)",
        ConfigFiles: files.join(","),
      })),
    ),
  );
}

function calls(): string[] {
  return docker.mock.calls.map(([command, args]) => [command, ...args].join(" "));
}

function worktreeFile(root: string, worktree: string): string {
  return join(root, ".claude", "worktrees", worktree, "compose.yaml");
}

function downs(): string[] {
  return calls().filter((call) => call.endsWith(" down --volumes"));
}

describe("projectName", () => {
  test("prefixes the worktree's directory name", () => {
    expect(projectName("/code/smonn-db/.claude/worktrees/rustling-weaving-thompson")).toBe(
      "smonndb-rustling-weaving-thompson",
    );
  });

  test("lowercases and replaces characters compose rejects", () => {
    expect(projectName("/code/My Repo.v2")).toBe("smonndb-my-repo-v2");
  });
});

describe("parsePort", () => {
  test("reads the host port from compose's address", () => {
    expect(parsePort("0.0.0.0:32768\n")).toBe(32768);
  });

  test("reads an IPv6 address", () => {
    expect(parsePort("[::]:32769\n")).toBe(32769);
  });

  test("allows trailing whitespace but not trailing text", () => {
    expect(parsePort("0.0.0.0:32768 \t\r\n")).toBe(32768);
    expect(parsePort("0.0.0.0:32768 and more")).toBeUndefined();
    expect(parsePort("0.0.0.0:3276x")).toBeUndefined();
  });

  test("reads only the first line", () => {
    expect(parsePort("0.0.0.0:1\n[::]:2\n")).toBe(1);
    expect(parsePort("no port\n0.0.0.0:2\n")).toBeUndefined();
  });

  test("returns undefined for output without a port", () => {
    expect(parsePort("")).toBeUndefined();
  });
});

describe("compose.yaml", () => {
  const compose = readFileSync(new URL("../compose.yaml", import.meta.url), "utf8");

  test("turns off fsync, which drop database's checkpoint waits on (#169)", () => {
    expect(compose).toMatch(/^\s+command: \["postgres", "-c", "fsync=off"\]$/mu);
  });

  test("checks readiness over TCP, which the image's init server doesn't listen on (#169)", () => {
    expect(compose).toMatch(
      /^\s+test: \["CMD", "pg_isready", "-h", "127\.0\.0\.1", "-U", "postgres"\]$/mu,
    );
  });
});

describe("main", () => {
  let root: string;
  let name: string;
  const envFile = (): string => join(root, ".env.test");

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "test-db-")));
    name = projectName(root);
    docker.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  test("starts compose on a Docker-assigned port and writes .env.test", () => {
    docker
      .mockReturnValueOnce(noProjects)
      .mockReturnValueOnce(fail('service "postgres" is not running'))
      .mockReturnValueOnce(ok())
      .mockReturnValueOnce(ok("0.0.0.0:32768\n"));

    main([], root);

    expect(calls()).toEqual([
      "docker compose ls --all --format json",
      `docker compose -p ${name} port postgres 5432`,
      `docker compose -p ${name} up -d --wait`,
      `docker compose -p ${name} port postgres 5432`,
    ]);
    expect(docker.mock.calls[2]?.[2].cwd).toBe(root);
    expect(docker.mock.calls[2]?.[2].encoding).toBe("utf8");
    expect(console.log).toHaveBeenCalledWith(
      `Container ${name}-postgres-1 is on port 32768; wrote .env.test`,
    );
    expect(docker.mock.calls[2]?.[2].env?.["POSTGRES_PORT"]).toBe("0");
    expect(readFileSync(envFile(), "utf8")).toBe(
      "DATABASE_URL=postgres://postgres:postgres@localhost:32768/postgres\n",
    );
  });

  test("reuses a running server's port without recreating it", () => {
    docker.mockReturnValueOnce(noProjects).mockReturnValueOnce(ok("0.0.0.0:32770\n"));

    main(["start"], root);

    expect(calls()).toEqual([
      "docker compose ls --all --format json",
      `docker compose -p ${name} port postgres 5432`,
    ]);
    expect(readFileSync(envFile(), "utf8")).toContain("localhost:32770/");
  });

  test("throws with compose's output when up fails", () => {
    docker
      .mockReturnValueOnce(noProjects)
      .mockReturnValueOnce(fail("not running"))
      .mockReturnValueOnce(fail("no daemon \n"));

    expect(() => {
      main([], root);
    }).toThrow(new Error(`docker compose -p ${name} up -d --wait failed:\nno daemon`));
    expect(existsSync(envFile())).toBe(false);
  });

  test("throws when the server has no port after starting", () => {
    docker
      .mockReturnValueOnce(noProjects)
      .mockReturnValueOnce(fail("not running"))
      .mockReturnValueOnce(ok())
      .mockReturnValueOnce(fail("not running"));

    expect(() => {
      main([], root);
    }).toThrow(`${name} started but publishes no port for 5432`);
  });

  describe("orphaned projects", () => {
    beforeEach(() => {
      mkdirSync(join(root, ".claude", "worktrees", "live"), { recursive: true });
      writeFileSync(worktreeFile(root, "live"), "");
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
      expect(readFileSync(envFile(), "utf8")).toContain("localhost:32768/");
    });
  });

  test("stop takes the project down and removes .env.test", () => {
    writeFileSync(envFile(), "DATABASE_URL=x\n");
    docker.mockReturnValueOnce(ok());

    main(["stop"], root);

    expect(calls()).toEqual([`docker compose -p ${name} down --volumes`]);
    expect(existsSync(envFile())).toBe(false);
    expect(console.log).toHaveBeenCalledWith(`Stopped ${name} and removed .env.test`);
  });

  test("stop works when .env.test is already gone", () => {
    docker.mockReturnValueOnce(ok());

    expect(() => {
      main(["stop"], root);
    }).not.toThrow();
  });

  test("works on the repo root when given no root", () => {
    docker
      .mockReturnValueOnce(noProjects)
      .mockReturnValueOnce(fail("not running"))
      .mockReturnValueOnce(fail("no daemon"));
    const repo = fileURLToPath(new URL("..", import.meta.url));

    expect(() => {
      main([]);
    }).toThrow(`docker compose -p ${projectName(repo)} up -d --wait failed`);
    expect(docker.mock.calls[1]?.[2].cwd).toBe(repo);
  });

  test("stop throws with compose's output when down fails", () => {
    docker.mockReturnValueOnce(fail("no daemon"));

    expect(() => {
      main(["stop"], root);
    }).toThrow(/down failed:\nno daemon/u);
  });

  test("rejects an unknown command by name", () => {
    expect(() => {
      main(["restart"], root);
    }).toThrow('Unknown arguments "restart". Usage: node scripts/test-db.ts [start|stop]');
    expect(docker).not.toHaveBeenCalled();
  });

  test("rejects arguments after the command", () => {
    expect(() => {
      main(["stop", "--volumes"], root);
    }).toThrow('Unknown arguments "stop --volumes". Usage: node scripts/test-db.ts [start|stop]');
    expect(docker).not.toHaveBeenCalled();
  });
});
