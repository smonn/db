/**
 * `smonn/test-server-url`, a rule of `lint-plugin.ts` in its own file to keep each file's fta score
 * low: no `process.env.DATABASE_URL` read, member or destructured. Tests call `testServerUrl()`
 * from `test-database.test-helper.ts`, which names the `test-db.ts` fix when no server is set.
 */
import type { RuleTester } from "oxlint/plugins-dev";

type Rule = Parameters<RuleTester["run"]>[1];
type Context = Parameters<Extract<Rule, { create: unknown }>["create"]>[0];
type Node = Parameters<Context["sourceCode"]["getScope"]>[0];

const DATABASE_URL = "DATABASE_URL";

function isProcessEnv(node: Node): boolean {
  return (
    node.type === "MemberExpression" &&
    !node.computed &&
    node.object.type === "Identifier" &&
    node.object.name === "process" &&
    node.property.type === "Identifier" &&
    node.property.name === "env"
  );
}

/** `.DATABASE_URL`, or `["DATABASE_URL"]`; `[name]` could be anything, so it passes. */
function isDatabaseUrlKey(key: Node, computed: boolean): boolean {
  if (computed) return key.type === "Literal" && key.value === DATABASE_URL;
  return key.type === "Identifier" && key.name === DATABASE_URL;
}

const MESSAGE =
  "Call testServerUrl() from test-database.test-helper.ts: a missing server then fails with the `node scripts/test-db.ts` hint instead of `Invalid URL`";

export const testServerUrl: Rule = {
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
        if (node.init === null || !isProcessEnv(node.init) || node.id.type !== "ObjectPattern") {
          return;
        }
        for (const property of node.id.properties) {
          if (property.type === "Property" && isDatabaseUrlKey(property.key, property.computed)) {
            context.report({ node: property, message: MESSAGE });
          }
        }
      },
    };
  },
};
