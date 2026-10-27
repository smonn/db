import { afterEach, describe, expect, test } from "vitest";
import { checkImports, importRules } from "./check-imports.ts";
import { removeRepos, repo, rulesBroken } from "./check-imports.test-helper.ts";

afterEach(removeRepos);

describe("checkImports scope", () => {
  test("names the missing scan when src holds no modules", async () => {
    expect(await checkImports(repo({ "src/.keep": "" }))).toEqual([
      { from: "src", to: "src", rule: "scanned 0 modules" },
    ]);
  });

  test("judges the imports of src/ files only, not those of files outside it", async () => {
    expect(
      await rulesBroken({
        "src/dev/diff/index.ts":
          'import { helper } from "../../../lib/helper.ts";\nexport { helper };',
        "lib/helper.ts":
          'import { readFileSync } from "node:fs";\nimport { sha } from "../src/runtime/index.ts";\nexport const helper = [readFileSync, sha];',
        "src/runtime/index.ts": "export const sha = 1;",
      }),
    ).toEqual([]);
  });

  test("does not scan files outside src that nothing in src imports", async () => {
    expect(
      await rulesBroken({
        "src/runtime/sql/index.ts": "export type S = 1;",
        "lib/stray.ts": 'import { t } from "./stray.test.ts";\nexport { t };',
        "lib/stray.test.ts": "export const t = 1;",
      }),
    ).toEqual([]);
  });
});

describe("importRules", () => {
  test.each(importRules.map((rule) => [rule.name, rule.comment]))(
    "explains %s",
    (_name, comment) => {
      expect(comment).toMatch(/^\S.*\.$/u);
    },
  );
});
