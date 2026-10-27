import { cruise } from "dependency-cruiser";
import { afterEach, describe, expect, test, vi } from "vitest";
import { checkImports, importRules } from "./check-imports.ts";
import { removeRepos, repo } from "./check-imports.test-helper.ts";

vi.mock("dependency-cruiser", async (importOriginal) => {
  const actual = await importOriginal<typeof import("dependency-cruiser")>();
  return { ...actual, cruise: vi.fn<typeof cruise>(actual.cruise) };
});

afterEach(removeRepos);

describe("checkImports through dependency-cruiser", () => {
  test("cruises src with the swc parser, validating against the rules", async () => {
    await checkImports(repo({ "src/runtime/sql/index.ts": "export type S = 1;" }));
    expect(cruise).toHaveBeenCalledWith(
      ["src"],
      expect.objectContaining({
        parser: "swc",
        validate: true,
        ruleSet: { forbidden: importRules },
        doNotFollow: { path: "node_modules" },
      }),
    );
  });

  test("fails when dependency-cruiser returns a formatted report", async () => {
    vi.mocked(cruise).mockResolvedValueOnce({ output: "report", exitCode: 0 });
    await expect(checkImports(process.cwd())).rejects.toThrow(
      "dependency-cruiser returned a formatted report",
    );
  });
});
