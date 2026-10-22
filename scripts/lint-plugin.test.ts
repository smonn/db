import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";
import plugin from "./lint-plugin.ts";

// oxlint-disable-next-line typescript/strict-void-return -- RuleTester ignores what describe returns.
RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({
  languageOptions: { sourceType: "module", parserOptions: { lang: "ts" } },
});

tester.run("sql-interpolation", plugin.rules["sql-interpolation"], {
  valid: [
    "await driver.execute(`create database ${quoteIdentifier(name)}`);",
    "const LOCK_KEY = 1;\nasync function f() { await session.query(`select pg_advisory_lock(${LOCK_KEY})`); }",
    "async function f(name) { const schema = quoteTrackingSchema(name); await tx.query(`select 1 from ${schema}.current`); }",
    "async function f(name) { const q = quoteIdentifier(name); const t = q; await tx.query(`select 1 from ${t}`); }",
    "await tx.query(`select ${1}`.trim());",
    "await tx.query(sql`select ${value}`);",
    "await tx.query(text);",
    "logger.info(`hello ${name}`);",
  ],
  invalid: [
    {
      code: "await driver.execute(`create database ${name}`);",
      errors: [{ message: /quoteIdentifier, or bind the value as a parameter of execute/u }],
    },
    {
      code: "await query(`select ${value}`);",
      errors: 1,
    },
    {
      code: "await sql.unsafe(`drop schema ${schema}`);",
      errors: 1,
    },
    {
      code: "async function f(name) { let schema = quoteIdentifier(name); await tx.query(`select 1 from ${schema}`); }",
      errors: 1,
    },
    {
      code: "async function f(name) { const schema = name; await tx.query(`select 1 from ${schema}`); }",
      errors: 1,
    },
    {
      code: "async function f(LOCK_KEY) { await tx.query(`select pg_advisory_lock(${LOCK_KEY})`); }",
      errors: [
        {
          message:
            /it accepts a quoteIdentifier call, a const set from one in scope, or a module-level const, not a parameter or a template/u,
        },
      ],
    },
    {
      code: "await tx.execute(`${drops.join(';')}\n${recreate(schema)}`);",
      errors: 2,
    },
  ],
});

tester.run("required-brand", plugin.rules["required-brand"], {
  valid: [
    'export type Query = { readonly "~returns": "rows" };',
    'type Internal = { readonly "~row"?: number };',
    "export type Options = { readonly name?: string };",
    'export interface Query { readonly "~returns": "rows" }',
    'export type Client = { one(query: { readonly "~many"?: never }): void };',
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
  ],
});
