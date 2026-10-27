import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";
import plugin from "./lint-plugin.ts";

// oxlint-disable-next-line typescript/strict-void-return -- RuleTester ignores what describe returns.
RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({
  languageOptions: { sourceType: "module", parserOptions: { lang: "ts" } },
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
    "let env;",
    "const env = process.env;",
    "const { DATABASE_URL } = other;",
    "const { ...rest } = process.env;",
    "class A { #env; f() { return process.#env.DATABASE_URL; } }",
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
