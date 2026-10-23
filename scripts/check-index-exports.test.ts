import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { checkGroupIndex, checkIndexExports, exportedNames, main } from "./check-index-exports.ts";

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("checkIndexExports", () => {
  test("passes named value and type re-exports", () => {
    const text = [
      'export { a, b as c } from "./a.ts";',
      'export type { T } from "./t.ts";',
      'export { type U, default as d } from "./u.ts";',
    ].join("\n");
    expect(checkIndexExports(text)).toEqual([]);
  });

  test("passes an empty file", () => {
    expect(checkIndexExports("")).toEqual([]);
  });

  test("rejects export *", () => {
    expect(checkIndexExports('export * from "./a.ts";')).toEqual([
      "`export *` hides the module's API; name each re-export",
    ]);
  });

  test("rejects export * as", () => {
    expect(checkIndexExports('export * as ns from "./a.ts";')).toEqual([
      "ExportNamespaceSpecifier is not a named re-export",
    ]);
  });

  test("rejects re-exporting a default", () => {
    expect(
      checkIndexExports(
        'export { default } from "./a.ts";\nexport { x as default } from "./b.ts";',
      ),
    ).toEqual([
      "re-exporting a default is not a named re-export",
      "re-exporting a default is not a named re-export",
    ]);
  });

  test("rejects declarations, local exports, and imports", () => {
    const text = [
      "export const a = 1;",
      "export type T = 1;",
      "const b = 2;",
      "export { b };",
      'import { c } from "./c.ts";',
      "export default c;",
    ].join("\n");
    expect(checkIndexExports(text)).toEqual([
      "ExportDeclaration is not a named re-export",
      "ExportDeclaration is not a named re-export",
      "VariableDeclaration is not a named re-export",
      "ExportNamedDeclaration is not a named re-export",
      "ImportDeclaration is not a named re-export",
      "ExportDefaultExpression is not a named re-export",
    ]);
  });
});

describe("exportedNames", () => {
  test("lists each re-exported name and marks type-only ones", () => {
    const text = [
      'export { a, b as c, type T } from "./a.ts";',
      'export type { U } from "./u.ts";',
    ].join("\n");
    expect(exportedNames(text)).toEqual(["a", "c", "type T", "type U"]);
  });
});

describe("checkGroupIndex", () => {
  test("passes when the group exports exactly its modules' names", () => {
    expect(checkGroupIndex(["a", "type T"], ["type T", "a"])).toEqual([]);
  });

  test("names what the group misses and what it adds", () => {
    expect(checkGroupIndex(["a", "type b", "c"], ["a", "b", "type T"])).toEqual([
      "misses b, which a module's index.ts exports",
      "misses type T, which a module's index.ts exports",
      "exports type b, which no module's index.ts exports",
      "exports c, which no module's index.ts exports",
    ]);
  });
});

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "check-index-exports-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const GROUP_INDEXES = {
  "src/runtime/index.ts": 'export { b } from "./sql/index.ts";',
  "src/runtime/sql/index.ts": 'export { b } from "./build.ts";',
  "src/runtime/internal/index.ts": 'export { hidden } from "./hidden.ts";',
  "src/dev/index.ts": 'export type { Config } from "./config/index.ts";',
  "src/dev/config/index.ts": 'export type { Config } from "./config.ts";',
  "src/dev/cli/index.ts": 'export { main } from "./main.ts";',
};

function runMain(files: Record<string, string>): string[][] {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const dir = repo(files);
  main(dir);
  rmSync(dir, { recursive: true, force: true });
  return errors.mock.calls;
}

describe("main", () => {
  test("prints each problem in src/**/index.ts and sets exit code 1", () => {
    const errors = runMain({
      ...GROUP_INDEXES,
      "src/runtime/sql/index.ts": "export const b = 1;",
      "src/runtime/sql/build.ts": "export const b = 1;",
    });
    expect(errors).toEqual([
      ["src/runtime/sql/index.ts: ExportDeclaration is not a named re-export"],
      ["src/runtime/index.ts: exports b, which no module's index.ts exports"],
    ]);
    expect(process.exitCode).toBe(1);
  });

  test("fails a group index that drifted from its modules' indexes", () => {
    const errors = runMain({
      ...GROUP_INDEXES,
      "src/dev/config/index.ts":
        'export { defineConfig } from "./config.ts";\nexport type { Config } from "./config.ts";',
    });
    expect(errors).toEqual([
      ["src/dev/index.ts: misses defineConfig, which a module's index.ts exports"],
    ]);
    expect(process.exitCode).toBe(1);
  });

  test("fails when a group index is missing", () => {
    const { "src/dev/index.ts": _dev, ...rest } = GROUP_INDEXES;
    expect(runMain(rest)).toEqual([["src/dev/index.ts: is missing"]]);
  });

  test("leaves the exit code alone when every index.ts passes", () => {
    expect(runMain(GROUP_INDEXES)).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });
});
