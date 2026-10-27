import { readFileSync } from "node:fs";
import { RuleTester } from "oxlint/plugins-dev";
import { describe, expect, it } from "vitest";
import plugin from "./lint-plugin.ts";

// oxlint-disable-next-line typescript/strict-void-return -- RuleTester ignores what describe returns.
RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({
  languageOptions: { sourceType: "module", parserOptions: { lang: "ts" } },
});

tester.run("required-brand", plugin.rules["required-brand"], {
  valid: [
    'export type Query = { readonly "~returns": "rows" };',
    'type Internal = { readonly "~row"?: number };',
    "export type Options = { readonly name?: string };",
    'export interface Query { readonly "~returns": "rows" }',
    'export type Client = { one(query: { readonly "~many"?: never }): void };',
    'function f(query: { readonly "~returns"?: "rows" }) {}',
    "export type Row = { readonly 1?: number };",
    'type Query = { readonly "~returns"?: "rows" };\nexport { Query } from "./other.ts";',
  ],
  invalid: [
    {
      code: 'export type Query<R> = { readonly "~returns"?: "rows"; readonly row: R };',
      errors: [
        {
          message:
            /Make "~returns" required: an optional brand lets a wider type stand in for Query/u,
        },
      ],
    },
    {
      code: 'export interface Query { readonly "~returns"?: "rows" }',
      errors: 1,
    },
    {
      code: 'type Query = { readonly "~returns"?: "rows" };\nexport { Query };',
      errors: 1,
    },
    {
      code: 'export type Query = Statement & { readonly "~row"?: number };',
      errors: 1,
    },
    {
      code: 'export type Query = { readonly "~row"? };',
      errors: 1,
    },
  ],
});

tester.run("error-message-qualifier", plugin.rules["error-message-qualifier"], {
  valid: [
    "throw new Error(`Refusing to touch ${quoted}.`);",
    "throw new Error(`Schema ${schema} is missing.\\nRun migrate.`);",
    "throw new Error(`${quoteIdentifier(schema)}.${quoteIdentifier('current')} is missing`);",
    "throw new Error('Table .current is missing');",
    "throw new Error(message);",
    "throw new Error();",
    "throw new Error(`${count} rows, see .gitignore`);",
    "throw new Thing(`${schema}.current`);",
    "log(`${schema}.current`);",
  ],
  invalid: [
    {
      code: "throw new Error(`Table ${schema}.current is missing`);",
      errors: [{ message: /Quote and qualify the identifier/u }],
    },
    {
      code: "throw new UsageError(`Missing ${tracking.name}.current`);",
      errors: 1,
    },
    {
      code: "throw new Error(`${a}.x and ${b}.y`);",
      errors: 2,
    },
    {
      code: "throw new Error(`${a}.x and ${b} y`);",
      errors: 1,
    },
  ],
});

tester.run("mock-child-process", plugin.rules["mock-child-process"], {
  valid: [
    'import { spawnSync } from "node:child_process";\nvi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));',
    'import type { spawnSync } from "node:child_process";',
    'import { type SpawnSyncReturns } from "node:child_process";',
    'import { readFileSync } from "node:fs";',
    'vi.mock("node:child_process", async (importOriginal) => importOriginal());',
  ],
  invalid: [
    {
      code: 'import { execFileSync } from "node:child_process";',
      errors: [{ message: /never a live gh call/u }],
    },
    {
      code: 'import { spawnSync } from "node:child_process";\nvi.mock("node:fs", () => ({}));',
      errors: 1,
    },
    {
      code: 'import * as cp from "node:child_process";',
      errors: 1,
    },
    {
      code: 'import { type SpawnSyncReturns, spawnSync } from "node:child_process";',
      errors: 1,
    },
    {
      code: 'import { spawnSync } from "node:child_process";\njest.mock("node:child_process");',
      errors: 1,
    },
    {
      code: 'import { spawnSync } from "node:child_process";\nvi.mock();',
      errors: 1,
    },
  ],
});

it("enables every rule in .oxlintrc.json under the plugin's name", () => {
  const config = readFileSync(new URL("../.oxlintrc.json", import.meta.url), "utf8");
  for (const rule of Object.keys(plugin.rules)) {
    expect(config).toContain(`"${plugin.meta.name}/${rule}": "error"`);
  }
});
