import { describe, expect, it, vi } from "vitest";
import { main } from "./main.ts";
import { run } from "./run.ts";

// The bin tests run --watch in a child process, which a mutant can't reach; this pins the parse.
vi.mock("./run.ts", () => ({ run: vi.fn<typeof run>(() => Promise.resolve(undefined)) }));
// main hands run whatever loadProject resolves to, so a stand-in shows it passed through.
vi.mock("./project.ts", () => ({ loadProject: () => Promise.resolve("project") }));

describe("main and --watch", () => {
  it.each([
    [["generate"], false],
    [["generate", "--watch"], true],
  ])("runs %j with watch %s", async (argv, watch) => {
    expect(await main(argv)).toBe(0);

    expect(vi.mocked(run)).toHaveBeenLastCalledWith(
      { name: "generate", watch, config: "smonndb.config.ts" },
      "project",
    );
  });
});
