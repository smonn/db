/**
 * `smonn/sql-interpolation`, a rule of `lint-plugin.ts` in its own file to keep each file's fta
 * score low: a `${...}` in a template literal passed straight to `query`, `unsafe`, or `execute`
 * must be a `quoteIdentifier` call, a `const` set from one, or a module-level constant.
 */
import type { RuleTester } from "oxlint/plugins-dev";

type Rule = Parameters<RuleTester["run"]>[1];
type Context = Parameters<Extract<Rule, { create: unknown }>["create"]>[0];
type Node = Parameters<Context["sourceCode"]["getScope"]>[0];
type Scope = ReturnType<Context["sourceCode"]["getScope"]>;

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

type Variable = NonNullable<ReturnType<Scope["set"]["get"]>>;

const isConstDeclaration = (parent: Node | null | undefined): boolean =>
  parent?.type === "VariableDeclaration" && parent.kind === "const";

function constDeclarator(variable: Variable) {
  const [definition] = variable.defs;
  if (variable.defs.length !== 1 || definition?.type !== "Variable") return null;
  if (!isConstDeclaration(definition.parent)) return null;
  return definition.node.type === "VariableDeclarator" ? definition.node : null;
}

function constBinding(node: Extract<Node, { type: "Identifier" }>, context: Context) {
  for (
    let scope: Scope | null = context.sourceCode.getScope(node);
    scope !== null;
    scope = scope.upper
  ) {
    const variable = scope.set.get(node.name);
    if (variable === undefined) continue;
    const declarator = constDeclarator(variable);
    if (declarator === null) return null;
    return { atModule: variable.scope.type === "module", init: declarator.init };
  }
  return null;
}

function isQuoterCall(node: Extract<Node, { type: "CallExpression" }>): boolean {
  const name = calleeName(node.callee);
  return name !== undefined && QUOTERS.has(name);
}

function isQuotedIdentifier(
  node: Extract<Node, { type: "Identifier" }>,
  context: Context,
  seen: Set<Node>,
): boolean {
  const binding = constBinding(node, context);
  if (binding === null) return false;
  if (binding.atModule) return true;
  return binding.init !== null && isQuoted(binding.init, context, seen);
}

function isQuoted(node: Node, context: Context, seen: Set<Node>): boolean {
  if (node.type === "CallExpression") return isQuoterCall(node);
  if (node.type !== "Identifier" || seen.has(node)) return false;
  seen.add(node);
  return isQuotedIdentifier(node, context, seen);
}

function isSqlTemplate(
  name: string | undefined,
  text: Node | undefined,
): text is Extract<Node, { type: "TemplateLiteral" }> {
  return name !== undefined && SQL_METHODS.has(name) && text?.type === "TemplateLiteral";
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
        if (!isSqlTemplate(name, text)) return;
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
