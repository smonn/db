/**
 * `smonn/sql-interpolation`, a rule of `lint-plugin.ts` in its own file to keep each file's fta
 * score low: a `${...}` in a template literal passed straight to `query`, `unsafe`, or `execute`
 * must be a `quoteIdentifier` call, a `const` set from one, or a module-level constant.
 */
import type { RuleTester } from "oxlint/plugins-dev";
import { field } from "./lint-ast.ts";

type Rule = Parameters<RuleTester["run"]>[1];
type Context = Parameters<Extract<Rule, { create: unknown }>["create"]>[0];
type Node = Parameters<Context["sourceCode"]["getScope"]>[0];
type Declarator = Extract<Node, { type: "VariableDeclarator" }>;
type Scope = ReturnType<Context["sourceCode"]["getScope"]>;
type Variable = NonNullable<ReturnType<Scope["set"]["get"]>>;

const SQL_METHODS: ReadonlySet<string | undefined> = new Set(["query", "unsafe", "execute"]);
// quoteTrackingSchema validates the name, then quotes it with quoteIdentifier.
const QUOTERS: ReadonlySet<string | undefined> = new Set([
  "quoteIdentifier",
  "quoteTrackingSchema",
]);

function calleeName(node: Node): string | undefined {
  if (node.type === "Identifier") return node.name;
  if (node.type === "MemberExpression" && !node.computed && node.property.type === "Identifier") {
    return node.property.name;
  }
  return undefined;
}

const isSqlMethod = (name: string | undefined): name is string => SQL_METHODS.has(name);
const isDeclarator = (node: Node): node is Declarator => node.type === "VariableDeclarator";

/** The variable an identifier reads; any other node is no reference, so it resolves to nothing. */
function resolve(node: Node, context: Context) {
  const { references } = context.sourceCode.getScope(node);
  return references.find((reference) => reference.identifier === node)?.resolved;
}

function constDeclarator(variable: Variable): Declarator | undefined {
  // A type of the same name adds a definition of its own.
  const declarator = variable.defs
    .map((definition) => definition.node)
    .find((node) => isDeclarator(node));
  // A declarator's parent, a VariableDeclaration, holds its `kind`.
  return declarator !== undefined && field(declarator.parent, "kind") === "const"
    ? declarator
    : undefined;
}

function isQuotedVariable(variable: Variable, context: Context, seen: Set<Node>): boolean {
  const declarator = constDeclarator(variable);
  if (declarator === undefined) return false;
  if (variable.scope.type === "module") return true;
  return declarator.init !== null && isQuoted(declarator.init, context, seen);
}

function isQuoted(node: Node, context: Context, seen: Set<Node>): boolean {
  if (node.type === "CallExpression") return QUOTERS.has(calleeName(node.callee));
  if (seen.has(node)) return false;
  seen.add(node);
  const variable = resolve(node, context);
  return variable !== undefined && variable !== null && isQuotedVariable(variable, context, seen);
}

export const sqlInterpolation: Rule = {
  meta: {
    type: "problem",
    docs: { description: "Quote identifiers and bind values in SQL passed as a template literal" },
  },
  create(context) {
    return {
      CallExpression(node) {
        const name = calleeName(node.callee);
        const [text] = node.arguments;
        if (!isSqlMethod(name) || text?.type !== "TemplateLiteral") return;
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
