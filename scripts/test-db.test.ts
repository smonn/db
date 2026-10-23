import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function calls(): string[] {
  return docker.mock.calls.map(([command, args]) => [command, ...args].join(" "));
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

  test("returns undefined for output without a port", () => {
    expect(parsePort("")).toBeUndefined();
  });
});

describe("compose.yaml", () => {
  const compose = readFileSync(new URL("../compose.yaml", import.meta.url), "utf8");

  test("turns off fsync, which drop database's checkpoint waits on (#169)", () => {
    expect(compose).toContain('command: ["postgres", "-c", "fsync=off"]');
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
      .mockReturnValueOnce(fail('service "postgres" is not running'))
      .mockReturnValueOnce(ok())
      .mockReturnValueOnce(ok("0.0.0.0:32768\n"));

    main([], root);

    expect(calls()).toEqual([
      `docker compose -p ${name} port postgres 5432`,
      `docker compose -p ${name} up -d --wait`,
      `docker compose -p ${name} port postgres 5432`,
    ]);
    expect(docker.mock.calls[1]?.[2].cwd).toBe(root);
    expect(docker.mock.calls[1]?.[2].env?.["POSTGRES_PORT"]).toBe("0");
    expect(readFileSync(envFile(), "utf8")).toBe(
      "DATABASE_URL=postgres://postgres:postgres@localhost:32768/postgres\n",
    );
  });

  test("reuses a running server's port without recreating it", () => {
    docker.mockReturnValueOnce(ok("0.0.0.0:32770\n"));

    main(["start"], root);

    expect(calls()).toEqual([`docker compose -p ${name} port postgres 5432`]);
    expect(readFileSync(envFile(), "utf8")).toContain("localhost:32770/");
  });

  test("throws with compose's output when up fails", () => {
    docker.mockReturnValueOnce(fail("not running")).mockReturnValueOnce(fail("no daemon"));

    expect(() => {
      main([], root);
    }).toThrow(/docker compose -p \S+ up -d --wait failed:\nno daemon/u);
    expect(existsSync(envFile())).toBe(false);
  });

  test("throws when the server has no port after starting", () => {
    docker
      .mockReturnValueOnce(fail("not running"))
      .mockReturnValueOnce(ok())
      .mockReturnValueOnce(fail("not running"));

    expect(() => {
      main([], root);
    }).toThrow(`${name} started but publishes no port for 5432`);
  });

  test("stop takes the project down and removes .env.test", () => {
    writeFileSync(envFile(), "DATABASE_URL=x\n");
    docker.mockReturnValueOnce(ok());

    main(["stop"], root);

    expect(calls()).toEqual([`docker compose -p ${name} down`]);
    expect(existsSync(envFile())).toBe(false);
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
