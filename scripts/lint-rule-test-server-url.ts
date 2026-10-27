/**
 * `smonn/test-server-url`, a rule of `lint-plugin.ts` in its own file to keep each file's fta score
 * low: no `process.env.DATABASE_URL` read, member or destructured. Tests call `testServerUrl()`
 * from `test-database.test-helper.ts`, which names the `test-db.ts` fix when no server is set.
 */
import type { RuleTester } from "oxlint/plugins-dev";
import { field, isIdentifier, isMember, named } from "./lint-ast.ts";

type Rule = Parameters<RuleTester["run"]>[1];
type Context = Parameters<Extract<Rule, { create: unknown }>["create"]>[0];
type Node = Parameters<Context["sourceCode"]["getScope"]>[0];

const DATABASE_URL = "DATABASE_URL";

const isProcessEnv = (node: Node): boolean => isMember(node, named("process"), named("env"));

/**
 * `.DATABASE_URL`, `["DATABASE_URL"]`, or a `"DATABASE_URL"` key; `[name]` could be anything, so
 * it passes. Only a literal has a value.
 */
function isDatabaseUrlKey(key: Node, computed: boolean): boolean {
  if (field(key, "value") === DATABASE_URL) return true;
  return !computed && isIdentifier(key, named(DATABASE_URL));
}

const MESSAGE =
  "Call testServerUrl() from test-database.test-helper.ts: a missing server then fails with the `node scripts/test-db.ts` hint instead of `Invalid URL`";

function destructuredDatabaseUrl(node: Extract<Node, { type: "VariableDeclarator" }>): Node[] {
  if (node.init === null || !isProcessEnv(node.init) || node.id.type !== "ObjectPattern") return [];
  return node.id.properties.filter(
    (property) => property.type === "Property" && isDatabaseUrlKey(property.key, property.computed),
  );
}

export const testServerUrlRule: Rule = {
  meta: {
    type: "problem",
    docs: { description: "Read the test server's DATABASE_URL through testServerUrl()" },
  },
  create(context) {
    return {
      MemberExpression(node) {
        if (isProcessEnv(node.object) && isDatabaseUrlKey(node.property, node.computed)) {
          context.report({ node, message: MESSAGE });
        }
      },
      VariableDeclarator(node) {
        for (const property of destructuredDatabaseUrl(node)) {
          context.report({ node: property, message: MESSAGE });
        }
      },
    };
  },
};
