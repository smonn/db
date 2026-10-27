import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { afterEach, describe, expect, test, vi } from "vitest";
import { main } from "./complexity.ts";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn<typeof spawnSync>() }));

const finding =
  "src/a.ts:14:1: function `alpha` has a complexity of 11. Maximum allowed is 8. [Error/eslint(complexity)]";
const oxlint: SpawnSyncReturns<string> = {
  pid: 0,
  output: [],
  stdout: `${finding}\n\n1 problem\n`,
  stderr: "",
  status: 1,
  signal: null,
};

describe("main with the default runner", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("runs oxlint over src and scripts with the written config and prints its findings", () => {
    vi.mocked(spawnSync).mockReturnValueOnce(oxlint);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    main(["8"]);
    expect(spawnSync).toHaveBeenCalledWith(
      "pnpm",
      [
        "exec",
        "oxlint",
        "-c",
        expect.stringMatching(/oxlint\.json$/u),
        "-f",
        "unix",
        "src",
        "scripts",
      ],
      { encoding: "utf8" },
    );
    expect(log).toHaveBeenCalledWith("11 alpha src/a.ts:14");
  });
});
