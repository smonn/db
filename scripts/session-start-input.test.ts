import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { main } from "./session-start.ts";

const mocks = vi.hoisted(() => ({
  spawn:
    vi.fn<
      (
        command: string,
        args: string[],
        options: { cwd: string },
      ) => { status: number; stdout: string; stderr: string }
    >(),
  stdin: vi.fn<(fd: number, options: unknown) => string>(),
}));

vi.mock("node:child_process", () => ({ spawnSync: mocks.spawn }));

vi.mock("node:fs", () => ({
  readFileSync: (fd: number, options: unknown) => mocks.stdin(fd, options),
}));

const subagent = { hook_event_name: "SubagentStart" };
const isTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");

function setTTY(value: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
}

function installedIn(): unknown {
  return mocks.spawn.mock.calls.find(([command]) => command === "pnpm")?.[2].cwd;
}

function output(): string[] {
  return vi.mocked(console.log).mock.calls.map(([line]) => String(line));
}

describe("main reading the hook input", () => {
  beforeEach(() => {
    // Every git call fails, which sends the sync down its fetch-failed path.
    mocks.spawn.mockImplementation((command) => ({
      status: command === "pnpm" ? 0 : 1,
      stdout: "",
      stderr: "",
    }));
    mocks.stdin.mockReset();
    mocks.stdin.mockReturnValue("");
    setTTY(false);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    if (isTTY) Object.defineProperty(process.stdin, "isTTY", isTTY);
    else Reflect.deleteProperty(process.stdin, "isTTY");
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    mocks.spawn.mockReset();
  });

  test("installs into the cwd the hook input names", () => {
    main({ cwd: "/work" }, "/fallback", "/other");
    expect(installedIn()).toBe("/work");
  });

  test("installs into the fallback when the input names no cwd", () => {
    main({}, "/fallback", "/other");
    expect(installedIn()).toBe("/fallback");
  });

  test("reads the hook input from stdin by default", () => {
    mocks.stdin.mockReturnValue('{"cwd":"/from-stdin"}');
    main(undefined, "/fallback", "/other");
    expect(installedIn()).toBe("/from-stdin");
    expect(mocks.stdin).toHaveBeenCalledWith(0, "utf8");
  });

  test("ignores stdin that is not JSON", () => {
    mocks.stdin.mockReturnValue("not json");
    main(undefined, "/fallback", "/other");
    expect(installedIn()).toBe("/fallback");
  });

  test("ignores stdin on a terminal", () => {
    setTTY(true);
    mocks.stdin.mockReturnValue('{"cwd":"/from-stdin"}');
    main(undefined, "/fallback", "/other");
    expect(installedIn()).toBe("/fallback");
  });

  test("ignores stdin that cannot be read", () => {
    mocks.stdin.mockImplementation(() => {
      throw new Error("EAGAIN");
    });
    main(undefined, "/fallback", "/other");
    expect(installedIn()).toBe("/fallback");
  });

  test("defaults the working directory to the process's", () => {
    vi.spyOn(process, "cwd").mockReturnValue("/process");
    main({}, undefined, "/other");
    expect(installedIn()).toBe("/process");
  });

  test("skips the sync for a subagent in $CLAUDE_PROJECT_DIR by default", () => {
    vi.stubEnv("CLAUDE_PROJECT_DIR", "/project");
    main(subagent, "/project");
    expect(output()).toEqual([]);
  });

  test("syncs a subagent outside $CLAUDE_PROJECT_DIR", () => {
    vi.stubEnv("CLAUDE_PROJECT_DIR", "/project");
    main(subagent, "/worktree");
    expect(output()).toEqual(["Could not fetch origin/main; the branch may be behind it."]);
  });
});
