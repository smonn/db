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
    "async function f(n) { const t = quoteIdentifier(n); type t = string; await tx.query(`select 1 from ${t}`); }",
    "async function f(n) { type t = string; const t = quoteIdentifier(n); await tx.query(`select 1 from ${t}`); }",
    "await tx.query(`select ${1}`.trim());",
    "await tx.query(sql`select ${value}`);",
    "await tx.query(text);",
    "await tx.query();",
    "logger.info(`hello ${name}`);",
    "f()(`select ${value}`);",
    "await tx[query](`select ${value}`);",
    "class A { #query(t) {} f(v) { this.#query(`select ${v}`); } }",
  ],
  invalid: [
    {
      code: "await tx.query(`select ${table.name}`);",
      errors: 1,
    },
    {
      code: "async function f(xs) { for (const s of xs) { await tx.query(`select 1 from ${s}`); } }",
      errors: 1,
    },
    {
      code: "function f() { const a = b; const b = a; return tx.query(`select ${a}`); }",
      errors: 1,
    },
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
