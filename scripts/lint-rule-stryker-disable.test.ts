import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";
import plugin from "./lint-plugin.ts";

// oxlint-disable-next-line typescript/strict-void-return -- RuleTester ignores what describe returns.
RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({
  languageOptions: { sourceType: "module", parserOptions: { lang: "ts" } },
});

const directive = "// Stryker disable next-line StringLiteral: the label is never shown";

tester.run("stryker-disable", plugin.rules["stryker-disable"], {
  valid: [
    `${directive}\nf("x");`,
    `function g() {\n  ${directive}\n  return "x";\n}`,
    '// A comment that mentions Stryker disable in passing.\nf("x");',
    '/** A block comment. */\nf("x");',
    'const text = "// Stryker disable all";',
  ],
  invalid: [
    {
      code: '// Stryker disable StringLiteral: file-wide\nf("x");',
      errors: [{ message: /`\/\/ Stryker disable next-line <Mutator>: <reason>`/u }],
    },
    {
      code: '// Stryker disable next-line StringLiteral\nf("x");',
      errors: 1,
    },
    {
      code: '/* Stryker disable next-line StringLiteral: block */\nf("x");',
      errors: [{ message: /`\/\/ Stryker disable next-line <Mutator>: <reason>`/u }],
    },
    {
      code: '// Stryker disable next-line all: everything\nf("x");',
      errors: [{ message: /rather than all/u }],
    },
    {
      code: `f("x"); ${directive}\ng("y");`,
      errors: [{ message: /alone on its line, directly above the code/u }],
    },
    {
      code: `${directive}\n\nf("x");`,
      errors: [{ message: /alone on its line, directly above the code/u }],
    },
    {
      code: `${directive}\n// Stryker disable next-line BlockStatement: stacked\nf("x");`,
      errors: [{ message: /alone on its line, directly above the code/u }],
    },
    {
      code: `function g() {\n  ${directive}\n  // Stryker disable next-line BlockStatement: stacked\n  return "x";\n}`,
      errors: [{ message: /alone on its line, directly above the code/u }],
    },
    {
      code: `${directive}\n  \nf("x");`,
      errors: [{ message: /alone on its line, directly above the code/u }],
    },
    {
      code: `f("x");\n${directive}`,
      errors: [{ message: /alone on its line, directly above the code/u }],
    },
  ],
});
