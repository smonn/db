import { afterEach, describe, expect, test } from "vitest";
import { removeRepos, rulesBroken } from "./check-imports.test-helper.ts";

afterEach(removeRepos);

describe("checkImports rules", () => {
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
      "adapter-imports-ports-or-internal",
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

  test("modules import runtime/internal, but no index.ts re-exports it", async () => {
    expect(
      await rulesBroken({
        "src/runtime/internal/index.ts": 'export { sha256 } from "./sha256.ts";',
        "src/runtime/internal/sha256.ts": "export const sha256 = 1;",
        "src/runtime/migrator/migrate.ts":
          'import { sha256 } from "../internal/index.ts";\nexport const hash = sha256;',
        "src/runtime/migrator/index.ts":
          'export { hash } from "./migrate.ts";\nexport { sha256 } from "../internal/index.ts";',
        "src/dev/generate/generate.ts":
          'import { sha256 } from "../../runtime/internal/index.ts";\nexport const hash = sha256;',
        "src/dev/generate/index.ts": 'export { hash } from "./generate.ts";',
        "src/adapters/node/source.ts":
          'import { sha256 } from "../../runtime/internal/index.ts";\nexport const hash = sha256;',
        "src/index.ts": 'export { sha256 } from "./runtime/internal/index.ts";',
      }),
    ).toEqual(["internal-not-reexported", "internal-not-reexported"]);
  });

  test("runtime/ imports no npm packages", async () => {
    expect(
      await rulesBroken({
        "src/runtime/sql/index.ts": 'import pad from "left-pad";\nexport { pad };',
      }),
    ).toEqual(["runtime-no-npm"]);
  });

  test("an adapter imports only runtime/ports, runtime/internal, and its own files", async () => {
    expect(
      await rulesBroken({
        "src/adapters/node/index.ts":
          'import type { D } from "../postgres-js/index.ts";\nimport type { S } from "../../runtime/sql/index.ts";\nimport type { E } from "../../dev/diff/index.ts";\nexport type N = D | S | E;',
        "src/adapters/postgres-js/index.ts": "export type D = 1;",
        "src/runtime/sql/index.ts": "export type S = 1;",
        "src/dev/diff/index.ts": "export type E = 1;",
      }),
    ).toEqual([
      "adapter-imports-ports-or-internal",
      "adapter-imports-ports-or-internal",
      "adapter-imports-ports-or-internal",
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

  test("no src/ file imports a group index", async () => {
    expect(
      await rulesBroken({
        "src/runtime/index.ts": 'export { s } from "./sql/index.ts";',
        "src/runtime/sql/index.ts": "export const s = 1;",
        "src/runtime/query/build.ts": 'import { s } from "../index.ts";\nexport const q = s;',
        "src/dev/index.ts": 'export { d } from "./diff/index.ts";',
        "src/dev/diff/index.ts": "export const d = 1;",
        "src/dev/cli/main.ts": 'import { d } from "../index.ts";\nexport const m = d;',
      }),
    ).toEqual(["no-group-index-imports", "no-group-index-imports"]);
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
});
