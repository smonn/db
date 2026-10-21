import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { checkImports, main } from "./check-imports.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "check-imports-"));
  dirs.push(dir);
  const all: Record<string, string> = {
    "package.json": JSON.stringify({
      type: "module",
      dependencies: { postgres: "*", "left-pad": "*" },
      devDependencies: { vitest: "*" },
    }),
    "node_modules/postgres/package.json": JSON.stringify({ name: "postgres", main: "index.js" }),
    "node_modules/postgres/index.js": "export default 1;",
    "node_modules/left-pad/package.json": JSON.stringify({ name: "left-pad", main: "index.js" }),
    "node_modules/left-pad/index.js": "export default 1;",
    "node_modules/vitest/package.json": JSON.stringify({ name: "vitest", main: "index.js" }),
    // An unresolvable import inside a package shows whether the cruise follows into node_modules.
    "node_modules/vitest/index.js": 'import "not-installed";\nexport const test = 1;',
    ...files,
  };
  for (const [path, text] of Object.entries(all)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

async function rulesBroken(files: Record<string, string>): Promise<string[]> {
  const problems = await checkImports(repo(files));
  return problems.map(({ rule }) => rule);
}

describe("checkImports", () => {
  test("fails when it scans no modules", async () => {
    expect(await rulesBroken({ "src/.keep": "" })).toEqual(["scanned 0 modules"]);
  });

  test("passes a layout that follows every rule", async () => {
    expect(
      await rulesBroken({
        "src/runtime/ports/index.ts": 'export type { Driver } from "./driver.ts";',
        "src/runtime/ports/driver.ts":
          "export type Driver = { query(text: string): Promise<unknown> };",
        "src/runtime/sql/index.ts":
          'import type { Driver } from "../ports/index.ts";\nexport type D = Driver;',
        "src/adapters/postgres-js/index.ts":
          'import postgres from "postgres";\nimport { readFile } from "node:fs";\nimport type { Driver } from "../../runtime/ports/index.ts";\nexport type D = Driver;\nexport { postgres, readFile };',
        "src/dev/diff/index.ts":
          'import type { D } from "../../runtime/sql/index.ts";\nexport type E = D;',
        "src/dev/cli/index.ts":
          'import { readFile } from "node:fs";\nimport type { D } from "../../adapters/postgres-js/index.ts";\nexport type F = D;\nexport { readFile };',
        "src/dev/diff/diff.test.ts":
          'import { test } from "vitest";\nimport { helper } from "./diff.test-helper.ts";\nimport { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";\nhelper(test);\nuseTestDatabase();',
        "src/dev/diff/diff.test-helper.ts":
          'import { test } from "vitest";\nexport function helper(t: typeof test): void {}',
        "src/runtime/sql/sql.test.ts":
          'import { test } from "vitest";\nimport { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";\nexport { test, useTestDatabase };',
        "src/adapters/postgres-js/test-database.test-helper.ts":
          'import postgres from "postgres";\nexport function useTestDatabase(): unknown {\n  return postgres;\n}',
        "src/adapters/postgres-js/driver.test.ts":
          'import { test } from "vitest";\nexport { test };',
        "src/adapters/node/fs.test.ts":
          'import { test } from "vitest";\nimport { useTestDatabase } from "../postgres-js/test-database.test-helper.ts";\nexport { test, useTestDatabase };',
      }),
    ).toEqual([]);
  });

  test("tests cross module boundaries only to reach the test database helper", async () => {
    expect(
      await rulesBroken({
        "src/runtime/sql/sql.test.ts":
          'import { postgresJsDriver } from "../../adapters/postgres-js/driver.ts";\nexport { postgresJsDriver };',
        "src/adapters/postgres-js/driver.ts": "export function postgresJsDriver(): void {}",
        "src/dev/shadow/shadow.test.ts":
          'import { diff } from "../diff/index.ts";\nimport { postgresJsDriver } from "../../adapters/postgres-js/driver.ts";\nexport { diff, postgresJsDriver };',
        "src/dev/diff/index.ts": "export function diff(): void {}",
        "src/adapters/node/fs.test.ts":
          'import { postgresJsDriver } from "../postgres-js/driver.ts";\nexport { postgresJsDriver };',
        "src/runtime/sql/index.ts":
          'import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";\nexport { useTestDatabase };',
        "src/adapters/postgres-js/test-database.test-helper.ts":
          "export function useTestDatabase(): void {}",
      }),
    ).toEqual([
      "adapter-imports-ports-only",
      "cross-module-through-index",
      "cross-module-through-index",
      "cross-module-through-index",
      "dev-no-adapters",
      "no-test-imports",
      "runtime-stays-in-runtime",
    ]);
  });

  test("runtime/ imports nothing outside runtime/", async () => {
    expect(
      await rulesBroken({
        "src/runtime/sql/index.ts":
          'import type { E } from "../../dev/diff/index.ts";\nexport type D = E;',
        "src/dev/diff/index.ts": "export type E = 1;",
      }),
    ).toEqual(["runtime-stays-in-runtime"]);
  });

  test("runtime/ imports no npm packages", async () => {
    expect(
      await rulesBroken({
        "src/runtime/sql/index.ts": 'import pad from "left-pad";\nexport { pad };',
      }),
    ).toEqual(["runtime-no-npm"]);
  });

  test("an adapter imports only runtime/ports and its own files", async () => {
    expect(
      await rulesBroken({
        "src/adapters/node/index.ts":
          'import type { D } from "../postgres-js/index.ts";\nimport type { S } from "../../runtime/sql/index.ts";\nimport type { E } from "../../dev/diff/index.ts";\nexport type N = D | S | E;',
        "src/adapters/postgres-js/index.ts": "export type D = 1;",
        "src/runtime/sql/index.ts": "export type S = 1;",
        "src/dev/diff/index.ts": "export type E = 1;",
      }),
    ).toEqual([
      "adapter-imports-ports-only",
      "adapter-imports-ports-only",
      "adapter-imports-ports-only",
    ]);
  });

  test("adapters/postgres-js imports no npm package but postgres", async () => {
    expect(
      await rulesBroken({
        "src/adapters/postgres-js/index.ts": 'import pad from "left-pad";\nexport { pad };',
      }),
    ).toEqual(["postgres-js-adapter-host-package"]);
  });

  test("other adapters import no npm packages", async () => {
    expect(
      await rulesBroken({
        "src/adapters/node/index.ts": 'import postgres from "postgres";\nexport { postgres };',
      }),
    ).toEqual(["adapter-no-npm"]);
  });

  test("dev/ outside dev/cli never imports adapters/", async () => {
    expect(
      await rulesBroken({
        "src/dev/diff/index.ts":
          'import type { D } from "../../adapters/postgres-js/index.ts";\nexport type E = D;',
        "src/adapters/postgres-js/index.ts": "export type D = 1;",
      }),
    ).toEqual(["dev-no-adapters"]);
  });

  test("node:* imports appear only in adapters/ and dev/cli", async () => {
    expect(
      await rulesBroken({
        "src/runtime/sql/index.ts": 'import { readFile } from "node:fs";\nexport { readFile };',
        "src/dev/diff/index.ts": 'import { readFile } from "node:fs";\nexport { readFile };',
      }),
    ).toEqual(["node-builtins-in-host-code", "node-builtins-in-host-code"]);
  });

  test("an import from another module goes through its index.ts", async () => {
    expect(
      await rulesBroken({
        "src/runtime/sql/index.ts":
          'import type { Q } from "../query/build.ts";\nexport type S = Q;',
        "src/runtime/query/build.ts": "export type Q = 1;",
      }),
    ).toEqual(["cross-module-through-index"]);
  });

  test("no cycles", async () => {
    expect(
      await rulesBroken({
        "src/runtime/sql/a.ts": 'import type { B } from "./b.ts";\nexport type A = B;',
        "src/runtime/sql/b.ts": 'import type { A } from "./a.ts";\nexport type B = A;',
      }),
    ).toEqual(["no-cycles"]);
  });

  test("non-test code never imports tests or test helpers", async () => {
    expect(
      await rulesBroken({
        "src/runtime/sql/index.ts":
          'import { helper } from "./sql.test-helper.ts";\nimport "./sql.test.ts";\nexport { helper };',
        "src/runtime/sql/sql.test-helper.ts": "export function helper(): void {}",
        "src/runtime/sql/sql.test.ts": "export {};",
      }),
    ).toEqual(["no-test-imports", "no-test-imports"]);
  });

  test("only tests and test helpers import vitest", async () => {
    expect(
      await rulesBroken({
        "src/dev/diff/index.ts": 'import { test } from "vitest";\nexport { test };',
      }),
    ).toEqual(["vitest-in-tests-only"]);
  });

  test("main prints each violation and sets exit code 1", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await main(
      repo({ "src/runtime/sql/index.ts": 'import pad from "left-pad";\nexport { pad };' }),
    );
    expect(errors.mock.calls).toEqual([
      ["src/runtime/sql/index.ts -> node_modules/left-pad/index.js: runtime-no-npm"],
    ]);
    expect(process.exitCode).toBe(1);
  });

  test("main leaves the exit code alone when every rule holds", async () => {
    await main(repo({ "src/runtime/sql/index.ts": "export type S = 1;" }));
    expect(process.exitCode).toBeUndefined();
  });

  test("every import resolves", async () => {
    expect(
      await rulesBroken({
        "src/runtime/sql/index.ts": 'import type { X } from "./missing.ts";\nexport type S = X;',
      }),
    ).toEqual(["no-unresolvable"]);
  });
});
