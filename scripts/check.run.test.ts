import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { main } from "./check.ts";
import { isReachable, testDatabaseUrl } from "./test-database-url.ts";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn<typeof spawnSync>() }));
vi.mock("./test-database-url.ts", () => ({
  isReachable: vi.fn<typeof isReachable>(),
  testDatabaseUrl: vi.fn<typeof testDatabaseUrl>(),
}));

const exit = (status: number): SpawnSyncReturns<string> => ({
  pid: 0,
  output: [],
  stdout: "",
  stderr: "",
  status,
  signal: null,
});

const ranScripts = (): string[] =>
  vi.mocked(spawnSync).mock.calls.map(([, args]) => String(args?.[1]));

describe("main with the default runner and database lookup", () => {
  beforeEach(() => {
    vi.mocked(spawnSync).mockReturnValue(exit(0));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(spawnSync).mockReset();
    vi.mocked(isReachable).mockReset();
    vi.mocked(testDatabaseUrl).mockReset();
    process.exitCode = undefined;
  });

  test("runs each script through pnpm with inherited output and announces it", async () => {
    await main(undefined, ["--static"]);
    expect(spawnSync).toHaveBeenCalledWith("pnpm", ["run", "format:check"], { stdio: "inherit" });
    expect(console.log).toHaveBeenCalledWith("\n> pnpm run format:check");
    expect(console.log).toHaveBeenLastCalledWith("\nAll 13 checks passed");
    expect(process.exitCode).toBeUndefined();
  });

  test("counts a script that exits non-zero as failed", async () => {
    vi.mocked(spawnSync).mockReturnValueOnce(exit(1));
    await main(undefined, ["--static"]);
    expect(console.error).toHaveBeenCalledWith("\n1 of 13 checks failed: format:check");
    expect(console.error).toHaveBeenLastCalledWith("Run `pnpm run format` to fix formatting.");
    expect(process.exitCode).toBe(1);
  });

  test("runs coverage and mutation:dry when the test database answers", async () => {
    vi.mocked(testDatabaseUrl).mockReturnValue("postgres://localhost:5432/db");
    vi.mocked(isReachable).mockResolvedValue(true);
    await main(undefined, []);
    expect(isReachable).toHaveBeenCalledWith("postgres://localhost:5432/db");
    expect(ranScripts()).toContain("coverage");
    expect(process.exitCode).toBeUndefined();
  });

  test.each([
    ["no URL is set", undefined, false],
    ["the server does not answer", "postgres://localhost:5432/db", false],
  ])("skips them and says so when %s", async (_name, url, reachable) => {
    vi.mocked(testDatabaseUrl).mockReturnValue(url);
    vi.mocked(isReachable).mockResolvedValue(reachable);
    await main(undefined, []);
    expect(ranScripts()).not.toContain("coverage");
    expect(console.error).toHaveBeenCalledWith("Skipped: no reachable test database.");
    expect(process.exitCode).toBe(1);
  });

  test("does not look for a server without a URL", async () => {
    vi.mocked(testDatabaseUrl).mockReturnValue(undefined);
    await main(undefined, []);
    expect(isReachable).not.toHaveBeenCalled();
  });

  test("reads its flags from the command line by default", async () => {
    const argv = process.argv;
    process.argv = ["node", "check.ts", "--static"];
    try {
      await main(undefined);
    } finally {
      process.argv = argv;
    }
    expect(ranScripts()).not.toContain("coverage");
    expect(testDatabaseUrl).not.toHaveBeenCalled();
  });

  test("names every unknown argument", async () => {
    await expect(main(undefined, ["--a", "--b"])).rejects.toThrow(
      'Unknown argument "--a --b"; expected --static.',
    );
  });

  test("adds the formatting hint only when the format check failed", async () => {
    vi.mocked(spawnSync).mockReturnValueOnce(exit(0)).mockReturnValueOnce(exit(1));
    await main(undefined, ["--static"]);
    expect(console.error).toHaveBeenCalledWith("\n1 of 13 checks failed: check:docs");
    expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining("pnpm run format"));
    expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining("test-db.ts"));
  });
});
