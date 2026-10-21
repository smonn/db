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
    }),
    "node_modules/postgres/package.json": JSON.stringify({ name: "postgres", main: "index.js" }),
    "node_modules/postgres/index.js": "export default 1;",
    "node_modules/left-pad/package.json": JSON.stringify({ name: "left-pad", main: "index.js" }),
    "node_modules/left-pad/index.js": "export default 1;",
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
        "src/dev/diff/diff.test.ts": 'import { helper } from "./diff.test-helper.ts";\nhelper();',
        "src/dev/diff/diff.test-helper.ts": "export function helper(): void {}",
      }),
    ).toEqual([]);
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
          'import type { D } from "../postgres-js/index.ts";\nimport type { S } from "../../runtime/sql/index.ts";\nexport type N = D | S;',
        "src/adapters/postgres-js/index.ts": "export type D = 1;",
        "src/runtime/sql/index.ts": "export type S = 1;",
      }),
    ).toEqual(["adapter-imports-ports-only", "adapter-imports-ports-only"]);
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
