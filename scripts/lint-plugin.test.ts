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

tester.run("error-message-qualifier", plugin.rules["error-message-qualifier"], {
  valid: [
    "throw new Error(`Refusing to touch ${quoted}.`);",
    "throw new Error(`Schema ${schema} is missing.\\nRun migrate.`);",
    "throw new Error(`${quoteIdentifier(schema)}.${quoteIdentifier('current')} is missing`);",
    "throw new Error('Table .current is missing');",
    "throw new Error(message);",
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
  ],
});

const CLEAR_GIT_ENV = 'import { isolateGitEnv } from "../src/dev/cli/git-env.test-helper.ts";\n';
const BEFORE_EACH = `${CLEAR_GIT_ENV}beforeEach(() => { isolateGitEnv(); });\n`;

tester.run("real-git-env", plugin.rules["real-git-env"], {
  valid: [
    `${BEFORE_EACH}execFileSync("git", ["init"], { cwd });`,
    `${BEFORE_EACH}child_process.spawnSync("git", ["status"]);`,
    'expect(execFileSync).toHaveBeenCalledWith("git", ["show", "HEAD"]);',
    'vi.mocked(execFileSync).mockReturnValue("");',
    'execFileSync("gh", ["pr", "view"]);',
    "execFileSync(command, args, options);",
    'execSync("github-cli --version");',
    `${BEFORE_EACH}execSync(\`git init\`);`,
    `${BEFORE_EACH}execFileSync("/usr/bin/git", []);`,
    'import * as h from "./git-env.test-helper.ts";\nbeforeEach(() => { h.isolateGitEnv(); });\nexecFileSync("git", []);',
    'mocks.execFileSync("git", ["init"]);',
    'import { execFileSync as run } from "node:child_process";\nrun("gh", []);',
    'import { spawn as run } from "node:child_process";\nother.run("git", []);',
    'import * as cp from "node:child_process";\ncp[execFileSync]("git", []);',
  ],
  invalid: [
    {
      code: 'execFileSync("git", ["init"], { cwd });',
      errors: [{ message: /isolateGitEnv\(\) from git-env\.test-helper\.ts/u }],
    },
    {
      code: 'import { spawnSync } from "node:child_process";\nspawnSync("git", ["status"]);\nchild_process.spawn("git", []);',
      errors: 2,
    },
    {
      code: 'execSync("git init");',
      errors: 1,
    },
    {
      code: "exec(`git commit -m ${message}`);",
      errors: 1,
    },
    {
      code: 'import { isolateGitEnv } from "./elsewhere.ts";\nexecFile("git", []);',
      errors: 1,
    },
    {
      code: 'import { other } from "./git-env.test-helper.ts";\nexecFileSync("git", []);',
      errors: 1,
    },
    {
      code: 'import { execFileSync as run } from "node:child_process";\nrun("git", []);',
      errors: 1,
    },
    {
      code: 'import * as cp from "node:child_process";\ncp.execFileSync("git", []);',
      errors: 1,
    },
    {
      code: 'execFileSync("/usr/bin/git", []);',
      errors: 1,
    },
    {
      code: `${CLEAR_GIT_ENV}isolateGitEnv();\nexecFileSync("git", []);`,
      errors: 1,
    },
    {
      code: `${CLEAR_GIT_ENV}it("x", () => { isolateGitEnv(); execFileSync("git", []); });`,
      errors: 1,
    },
    {
      code: `${CLEAR_GIT_ENV}beforeEach(() => {});\nexecFileSync("git", []);`,
      errors: 1,
    },
  ],
});

tester.run("test-server-url", plugin.rules["test-server-url"], {
  valid: [
    "const url = testServerUrl();",
    "const home = process.env.HOME;",
    'const home = process.env["HOME"];',
    "const url = env.DATABASE_URL;",
    "const url = process.env[name];",
    "const url = process.env[DATABASE_URL];",
    "const { HOME } = process.env;",
    'const env = { DATABASE_URL: "x" };',
  ],
  invalid: [
    {
      code: 'const url = new URL(String(process.env["DATABASE_URL"]));',
      errors: [{ message: /testServerUrl\(\)/u }],
    },
    {
      code: "const url = process.env.DATABASE_URL ?? '';",
      errors: 1,
    },
    {
      code: "const { DATABASE_URL } = process.env;",
      errors: 1,
    },
    {
      code: 'const { ["DATABASE_URL"]: url } = process.env;',
      errors: 1,
    },
    {
      code: 'const { "DATABASE_URL": url } = process.env;',
      errors: 1,
    },
  ],
});
