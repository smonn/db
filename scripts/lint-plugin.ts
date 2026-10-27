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
 * - `smonn/real-git-env`: a test that spawns `git` imports `isolateGitEnv`; see
 *   `lint-rule-real-git-env.ts`.
 * - `smonn/stryker-disable`: a Stryker directive is a reasoned, one-line disable; see
 *   `lint-rule-stryker-disable.ts`.
 */
import type { RuleTester } from "oxlint/plugins-dev";
import { field, isIdentifier, isMember, named } from "./lint-ast.ts";
import { realGitEnvRule } from "./lint-rule-real-git-env.ts";
import { sqlInterpolation } from "./lint-rule-sql-interpolation.ts";
import { strykerDisableRule } from "./lint-rule-stryker-disable.ts";
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
      | "test-server-url"
      | "real-git-env"
      | "stryker-disable",
      Rule
    >
  >;
};

type Property = Extract<Node, { type: "TSPropertySignature" }>;
type TypeDeclaration = Extract<Node, { type: "TSTypeAliasDeclaration" | "TSInterfaceDeclaration" }>;

/** An identifier key's name, or a literal key's value; any other key has no `value`. */
function keyName(key: Node): unknown {
  return key.type === "Identifier" ? key.name : field(key, "value");
}

function enclosingTypeDeclaration(start: Node): TypeDeclaration | null {
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

function optionalBrand(node: Property): string | undefined {
  const name = keyName(node.key);
  if (!node.optional || typeof name !== "string" || !name.startsWith("~")) return undefined;
  // `?: never` forbids the key rather than branding the type.
  return node.typeAnnotation?.typeAnnotation.type === "TSNeverKeyword" ? undefined : name;
}

type Brand = { readonly node: Property; readonly name: string; readonly type: TypeDeclaration };

const requiredBrand: Rule = {
  meta: {
    type: "problem",
    docs: { description: "Require brand properties, whose keys start with ~, on exported types" },
  },
  create(context) {
    const exported = new Set<unknown>();
    const brands: Brand[] = [];
    return {
      ExportNamedDeclaration(node) {
        if (node.source !== null) return;
        for (const specifier of node.specifiers) exported.add(keyName(specifier.local));
      },
      TSPropertySignature(node) {
        const name = optionalBrand(node);
        if (name === undefined) return;
        const type = enclosingTypeDeclaration(node);
        if (type !== null) brands.push({ node, name, type });
      },
      "Program:exit"() {
        for (const { node, name, type } of brands) {
          const typeName = type.id.name;
          if (type.parent.type !== "ExportNamedDeclaration" && !exported.has(typeName)) continue;
          context.report({
            node,
            message: `Make "${name}" required: an optional brand lets a wider type stand in for ${typeName}`,
          });
        }
      },
    };
  },
};

const DOTTED_NAME = /^\.[A-Za-z_$]/u;

function dottedInterpolations(node: Extract<Node, { type: "NewExpression" }>): Node[] {
  const [text] = node.arguments;
  const isError = isIdentifier(node.callee, (name) => name.endsWith("Error"));
  if (!isError || text?.type !== "TemplateLiteral") return [];
  // The quasi after each `${...}` holds the text that follows it.
  return text.quasis
    .slice(1)
    .flatMap((quasi, index) =>
      DOTTED_NAME.test(quasi.value.raw) ? text.expressions.slice(index, index + 1) : [],
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

function isViMockOfChildProcess(node: Extract<Node, { type: "CallExpression" }>): boolean {
  const [first] = node.arguments;
  return (
    isMember(node.callee, named("vi"), named("mock")) &&
    first?.type === "Literal" &&
    first.value === CHILD_PROCESS
  );
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
        // Only an ImportSpecifier has an `importKind`.
        const typeOnly = node.specifiers.every(
          (specifier) => field(specifier, "importKind") === "type",
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
    "real-git-env": realGitEnvRule,
    "stryker-disable": strykerDisableRule,
  },
};
export default plugin;
