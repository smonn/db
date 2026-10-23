/**
 * Oxlint JS plugin with the repo's own rules, loaded through `jsPlugins` in `.oxlintrc.json`, so
 * `pnpm lint` runs them in CI.
 *
 * - `smonn/sql-interpolation`: a `${...}` in a template literal passed straight to `query`,
 *   `unsafe`, or `execute` must be a `quoteIdentifier` call, a `const` set from one, or a
 *   module-level constant.
 * - `smonn/error-message-qualifier`: a template literal passed to `new Error(...)`, or to a class
 *   whose name ends in `Error`, has no `.` and identifier character directly after a `${...}`.
 * - `smonn/required-brand`: an exported type has no optional property whose key starts with `~`.
 * - `smonn/mock-child-process`: a file that imports a value from `node:child_process` also calls
 *   `vi.mock("node:child_process", ...)`, so a script test cannot run `gh` against the live repo.
 */
import type { RuleTester } from "oxlint/plugins-dev";

type Rule = Parameters<RuleTester["run"]>[1];
type Context = Parameters<Extract<Rule, { create: unknown }>["create"]>[0];
type Node = Parameters<Context["sourceCode"]["getScope"]>[0];
type Scope = ReturnType<Context["sourceCode"]["getScope"]>;
type Plugin = {
  readonly meta: { readonly name: string };
  readonly rules: Readonly<
    Record<
      "sql-interpolation" | "required-brand" | "error-message-qualifier" | "mock-child-process",
      Rule
    >
  >;
};

const SQL_METHODS = new Set(["query", "unsafe", "execute"]);
// quoteTrackingSchema validates the name, then quotes it with quoteIdentifier.
const QUOTERS = new Set(["quoteIdentifier", "quoteTrackingSchema"]);

function calleeName(node: Node): string | undefined {
  if (node.type === "Identifier") return node.name;
  if (node.type === "MemberExpression" && !node.computed && node.property.type === "Identifier") {
    return node.property.name;
  }
  return undefined;
}

function isQuoted(node: Node, context: Context, seen: Set<Node>): boolean {
  if (node.type === "CallExpression") {
    const name = calleeName(node.callee);
    return name !== undefined && QUOTERS.has(name);
  }
  if (node.type !== "Identifier" || seen.has(node)) return false;
  seen.add(node);
  for (
    let scope: Scope | null = context.sourceCode.getScope(node);
    scope !== null;
    scope = scope.upper
  ) {
    const variable = scope.set.get(node.name);
    if (variable === undefined) continue;
    const [definition] = variable.defs;
    if (
      variable.defs.length !== 1 ||
      definition?.type !== "Variable" ||
      definition.parent?.type !== "VariableDeclaration" ||
      definition.parent.kind !== "const" ||
      definition.node.type !== "VariableDeclarator"
    ) {
      return false;
    }
    if (variable.scope.type === "module") return true;
    const init = definition.node.init;
    return init !== null && isQuoted(init, context, seen);
  }
  return false;
}

const sqlInterpolation: Rule = {
  meta: {
    type: "problem",
    docs: { description: "Quote identifiers and bind values in SQL passed as a template literal" },
  },
  create(context) {
    return {
      CallExpression(node) {
        const name = calleeName(node.callee);
        const [text] = node.arguments;
        if (name === undefined || !SQL_METHODS.has(name) || text?.type !== "TemplateLiteral") {
          return;
        }
        for (const expression of text.expressions) {
          if (isQuoted(expression, context, new Set())) continue;
          context.report({
            node: expression,
            message: `Quote this identifier with quoteIdentifier, or bind the value as a parameter of ${name}; it accepts a quoteIdentifier call, a const set from one in scope, or a module-level const, not a parameter or a template built from quoted parts`,
          });
        }
      },
    };
  },
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

const requiredBrand: Rule = {
  meta: {
    type: "problem",
    docs: { description: "Require brand properties, whose keys start with ~, on exported types" },
  },
  create(context) {
    return {
      TSPropertySignature(node) {
        const name = keyName(node.key);
        if (!node.optional || name?.startsWith("~") !== true) return;
        // `?: never` forbids the key rather than branding the type.
        if (node.typeAnnotation?.typeAnnotation.type === "TSNeverKeyword") return;
        let declaration: Node = node;
        while (
          declaration.type !== "TSTypeAliasDeclaration" &&
          declaration.type !== "TSInterfaceDeclaration"
        ) {
          if (declaration.parent === null) return;
          declaration = declaration.parent;
        }
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

const errorMessageQualifier: Rule = {
  meta: {
    type: "problem",
    docs: { description: "Quote and qualify identifiers an error message names" },
  },
  create(context) {
    return {
      NewExpression(node) {
        const [text] = node.arguments;
        if (!isErrorConstructor(node.callee) || text?.type !== "TemplateLiteral") return;
        for (const [index, expression] of text.expressions.entries()) {
          const after = text.quasis[index + 1]?.value.raw ?? "";
          if (!DOTTED_NAME.test(after)) continue;
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

function isViMockOfChildProcess(node: Node): boolean {
  if (node.type !== "CallExpression") return false;
  const { callee } = node;
  const [first] = node.arguments;
  return (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.object.type === "Identifier" &&
    callee.object.name === "vi" &&
    callee.property.type === "Identifier" &&
    callee.property.name === "mock" &&
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
  },
};
export default plugin;
