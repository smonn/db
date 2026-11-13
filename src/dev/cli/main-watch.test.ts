import { describe, expect, it, vi } from "vitest";
import { main } from "./main.ts";
import { run } from "./run.ts";
import { watchGenerate } from "./watch-command.ts";

// The bin tests run --watch in a child process, which a mutant can't reach; this pins the parse.
vi.mock("./run.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./run.ts")>()),
  run: vi.fn<typeof run>(() =>
    Promise.resolve({ command: "migrate", ok: true, applied: [], skipped: [] }),
  ),
}));
vi.mock("./watch-command.ts", () => ({
  watchGenerate: vi.fn<typeof watchGenerate>(() => Promise.resolve()),
}));
// main hands the command whatever loadProject resolves to, so a stand-in shows it passed through.
vi.mock("./project.ts", () => ({ loadProject: () => Promise.resolve("project") }));

describe("main and --watch", () => {
  it("runs generate once without --watch", async () => {
    expect(await main(["generate"])).toBe(0);

    expect(vi.mocked(run)).toHaveBeenLastCalledWith(
      { name: "generate", watch: false, config: "smonndb.config.ts" },
      "project",
    );
  });

  it("hands generate --watch to the watch command", async () => {
    expect(await main(["generate", "--watch"])).toBe(0);

    expect(vi.mocked(watchGenerate)).toHaveBeenLastCalledWith("project", false);
  });
});
