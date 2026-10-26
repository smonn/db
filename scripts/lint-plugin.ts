/**
 * Oxlint JS plugin with the repo's own rules, loaded through `jsPlugins` in `.oxlintrc.json`, so
 * `pnpm lint` runs them in CI.
 *
 * - `smonn/sql-interpolation`: a `${...}` in a template literal passed straight to `query`,
 *   `unsafe`, or `execute` must be a `quoteIdentifier` call, a `const` set from one, or a
 *   module-level constant; see `lint-rule-sql-interpolation.ts`.
 * - `smonn/error-message-qualifier`: a template literal passed to `new Error(...)`, or to a class
 *   whose name ends in `Error`, has no `.` and identifier character directly after a `${...}`.
 * - `smonn/required-brand`: an exported type has no optional property whose key starts with `~`.
 * - `smonn/mock-child-process`: a file that imports a value from `node:child_process` also calls
 *   `vi.mock("node:child_process", ...)`, so a script test cannot run `gh` against the live repo.
 * - `smonn/test-server-url`: no `process.env.DATABASE_URL` read in a test; see
 *   `lint-rule-test-server-url.ts`.
 */
import type { RuleTester } from "oxlint/plugins-dev";
import { sqlInterpolation } from "./lint-rule-sql-interpolation.ts";
import { testServerUrlRule } from "./lint-rule-test-server-url.ts";

type Rule = Parameters<RuleTester["run"]>[1];
type Context = Parameters<Extract<Rule, { create: unknown }>["create"]>[0];
type Node = Parameters<Context["sourceCode"]["getScope"]>[0];
type Plugin = {
  readonly meta: { readonly name: string };
  readonly rules: Readonly<
    Record<
      | "sql-interpolation"
      | "required-brand"
      | "error-message-qualifier"
      | "mock-child-process"
      | "test-server-url",
      Rule
    >
  >;
};

function isExported(declaration: Node, name: string, program: Node): boolean {
  if (declaration.parent?.type === "ExportNamedDeclaration") return true;
  if (program.type !== "Program") return false;
  return program.body.some(
    (statement) =>
      statement.type === "ExportNamedDeclaration" &&
      statement.source === null &&
      statement.specifiers.some(
        (specifier) => specifier.local.type === "Identifier" && specifier.local.name === name,
      ),
  );
}

function keyName(key: Node): string | undefined {
  if (key.type === "Identifier") return key.name;
  if (key.type === "Literal" && typeof key.value === "string") return key.value;
  return undefined;
}

function enclosingTypeDeclaration(start: Node) {
  let declaration: Node = start;
  while (
    declaration.type !== "TSTypeAliasDeclaration" &&
    declaration.type !== "TSInterfaceDeclaration"
  ) {
    if (declaration.parent === null) return null;
    declaration = declaration.parent;
  }
  return declaration;
}

function isOptionalBrand(
  node: Extract<Node, { type: "TSPropertySignature" }>,
  name: string | undefined,
): boolean {
  if (!node.optional || name?.startsWith("~") !== true) return false;
  // `?: never` forbids the key rather than branding the type.
  return node.typeAnnotation?.typeAnnotation.type !== "TSNeverKeyword";
}

const requiredBrand: Rule = {
  meta: {
    type: "problem",
    docs: { description: "Require brand properties, whose keys start with ~, on exported types" },
  },
  create(context) {
    return {
      TSPropertySignature(node) {
        const name = keyName(node.key);
        if (!isOptionalBrand(node, name)) return;
        const declaration = enclosingTypeDeclaration(node);
        if (declaration === null) return;
        if (!isExported(declaration, declaration.id.name, context.sourceCode.ast)) return;
        context.report({
          node,
          message: `Make "${name}" required: an optional brand lets a wider type stand in for ${declaration.id.name}`,
        });
      },
    };
  },
};

const DOTTED_NAME = /^\.[A-Za-z_$]/u;

function isErrorConstructor(callee: Node): boolean {
  return callee.type === "Identifier" && callee.name.endsWith("Error");
}

function dottedInterpolations(node: Extract<Node, { type: "NewExpression" }>): Node[] {
  const [text] = node.arguments;
  if (!isErrorConstructor(node.callee) || text?.type !== "TemplateLiteral") return [];
  return text.expressions.filter((_, index) =>
    DOTTED_NAME.test(text.quasis[index + 1]?.value.raw ?? ""),
  );
}

const errorMessageQualifier: Rule = {
  meta: {
    type: "problem",
    docs: { description: "Quote and qualify identifiers an error message names" },
  },
  create(context) {
    return {
      NewExpression(node) {
        for (const expression of dottedInterpolations(node)) {
          context.report({
            node: expression,
            message:
              "Quote and qualify the identifier this message names, such as `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`: a dotted, unquoted name can spell two objects",
          });
        }
      },
    };
  },
};

const CHILD_PROCESS = "node:child_process";

function isViMockCallee(callee: Node): boolean {
  return (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.object.type === "Identifier" &&
    callee.object.name === "vi" &&
    callee.property.type === "Identifier" &&
    callee.property.name === "mock"
  );
}

function isViMockOfChildProcess(node: Node): boolean {
  if (node.type !== "CallExpression") return false;
  const [first] = node.arguments;
  return isViMockCallee(node.callee) && first?.type === "Literal" && first.value === CHILD_PROCESS;
}

const mockChildProcess: Rule = {
  meta: {
    type: "problem",
    docs: { description: "Mock node:child_process in any test that imports a value from it" },
  },
  create(context) {
    let imported: Node | undefined;
    let mocked = false;
    return {
      ImportDeclaration(node) {
        if (node.source.value !== CHILD_PROCESS || node.importKind === "type") return;
        const typeOnly = node.specifiers.every(
          (specifier) => specifier.type === "ImportSpecifier" && specifier.importKind === "type",
        );
        if (!typeOnly) imported ??= node;
      },
      CallExpression(node) {
        if (isViMockOfChildProcess(node)) mocked = true;
      },
      "Program:exit"() {
        if (imported === undefined || mocked) return;
        context.report({
          node: imported,
          message:
            'Call vi.mock("node:child_process", ...) in this file: tracker tooling is tested against recorded payloads, never a live gh call',
        });
      },
    };
  },
};

const plugin: Plugin = {
  meta: { name: "smonn" },
  rules: {
    "sql-interpolation": sqlInterpolation,
    "required-brand": requiredBrand,
    "error-message-qualifier": errorMessageQualifier,
    "mock-child-process": mockChildProcess,
    "test-server-url": testServerUrlRule,
  },
};
export default plugin;
