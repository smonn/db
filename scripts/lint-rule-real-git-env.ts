/**
 * `smonn/real-git-env`, a rule of `lint-plugin.ts` in its own file to keep each file's fta score
 * low: a test that spawns `git` imports `isolateGitEnv` from `git-env.test-helper.ts`. A git hook
 * exports `GIT_DIR`, which overrides `cwd`, so without it the test's git calls, and those of the
 * code it tests, write to the pushing repository (#539).
 */
import type { RuleTester } from "oxlint/plugins-dev";

type Rule = Parameters<RuleTester["run"]>[1];
type Context = Parameters<Extract<Rule, { create: unknown }>["create"]>[0];
type Node = Parameters<Context["sourceCode"]["getScope"]>[0];

const SPAWNS = new Set(["exec", "execSync", "execFile", "execFileSync", "spawn", "spawnSync"]);
const HELPER = /(^|\/)git-env\.test-helper\.ts$/u;
const GIT_COMMAND = /^git(\s|$)/u;

const MESSAGE =
  "Import isolateGitEnv() from git-env.test-helper.ts and call it before each test: a git hook exports GIT_DIR, which points this git call at the pushing repository";

function calleeName(callee: Node): string | undefined {
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression" && callee.property.type === "Identifier") {
    return callee.property.name;
  }
  return undefined;
}

function commandText(argument: Node): string | undefined {
  if (argument.type === "Literal" && typeof argument.value === "string") return argument.value;
  if (argument.type === "TemplateLiteral") return argument.quasis[0]?.value.raw;
  return undefined;
}

function spawnsGit(node: Extract<Node, { type: "CallExpression" }>): boolean {
  const [command] = node.arguments;
  if (command === undefined || !SPAWNS.has(calleeName(node.callee) ?? "")) return false;
  return GIT_COMMAND.test(commandText(command) ?? "");
}

function importsClearGitEnv(node: Extract<Node, { type: "ImportDeclaration" }>): boolean {
  if (!HELPER.test(node.source.value)) return false;
  return node.specifiers.some(
    (specifier) =>
      specifier.type === "ImportSpecifier" &&
      specifier.imported.type === "Identifier" &&
      specifier.imported.name === "isolateGitEnv",
  );
}

export const realGitEnvRule: Rule = {
  meta: {
    type: "problem",
    docs: { description: "Clear GIT_* variables in a test that runs real git" },
  },
  create(context) {
    const gitCalls: Node[] = [];
    let cleared = false;
    return {
      ImportDeclaration(node) {
        if (importsClearGitEnv(node)) cleared = true;
      },
      CallExpression(node) {
        if (spawnsGit(node)) gitCalls.push(node);
      },
      "Program:exit"() {
        if (cleared) return;
        for (const node of gitCalls) context.report({ node, message: MESSAGE });
      },
    };
  },
};
