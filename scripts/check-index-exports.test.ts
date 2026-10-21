import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { checkIndexExports, main } from "./check-index-exports.ts";

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

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "check-index-exports-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

describe("main", () => {
  test("prints each problem in src/**/index.ts and sets exit code 1", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = repo({
      "src/runtime/sql/index.ts": "export const a = 1;",
      "src/runtime/sql/build.ts": "export const b = 1;",
    });
    main(dir);
    rmSync(dir, { recursive: true, force: true });
    expect(errors.mock.calls).toEqual([
      ["src/runtime/sql/index.ts: ExportDeclaration is not a named re-export"],
    ]);
    expect(process.exitCode).toBe(1);
  });

  test("leaves the exit code alone when every index.ts passes", () => {
    const dir = repo({ "src/runtime/sql/index.ts": 'export { b } from "./build.ts";' });
    main(dir);
    rmSync(dir, { recursive: true, force: true });
    expect(process.exitCode).toBeUndefined();
  });
});
