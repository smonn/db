import { afterEach, describe, expect, test, vi } from "vitest";
import { main } from "./check-imports.ts";
import { removeRepos, repo, rulesBroken } from "./check-imports.test-helper.ts";

afterEach(() => {
  removeRepos();
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

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

  test("no cycles", async () => {
    expect(
      await rulesBroken({
        "src/runtime/sql/a.ts": 'import type { B } from "./b.ts";\nexport type A = B;',
        "src/runtime/sql/b.ts": 'import type { A } from "./a.ts";\nexport type B = A;',
      }),
    ).toEqual(["no-cycles"]);
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
