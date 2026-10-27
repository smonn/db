import { readFileSync } from "node:fs";
import { runFta } from "fta-cli";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { main } from "./fta-check.ts";

vi.mock("fta-cli", () => ({ runFta: vi.fn<typeof runFta>() }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn<typeof actual.readFileSync>() };
});

describe("main with the default scorer", () => {
  beforeEach(() => {
    vi.mocked(readFileSync).mockReturnValue("{}");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  test("scores src and scripts through fta as JSON and reads the baselines as UTF-8", () => {
    vi.mocked(runFta).mockImplementation((dir) =>
      JSON.stringify([{ file_name: `${dir}.ts`, fta_score: 12 }]),
    );
    main([], undefined, "baseline.json");
    expect(runFta).toHaveBeenCalledWith("src", { json: true });
    expect(runFta).toHaveBeenCalledWith("scripts", { json: true });
    expect(readFileSync).toHaveBeenCalledWith("baseline.json", "utf8");
    expect(console.log).toHaveBeenCalledWith("fta: 2 files within their limits.");
  });
});
