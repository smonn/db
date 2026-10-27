/**
 * `smonn/real-git-env`, a rule of `lint-plugin.ts` in its own file to keep each file's fta score
 * low: a test that spawns `git` imports `isolateGitEnv` from `git-env.test-helper.ts` and calls it
 * in a `beforeEach` callback. A git hook exports `GIT_DIR`, which overrides `cwd`, so without it
 * the test's git calls, and those of the code it tests, write to the pushing repository (#539).
 *
 * It sees a spawn function called by its name, under any alias imported from `node:child_process`,
 * or through that module's namespace, with a command whose basename is `git`. A call on any other
 * object, such as `mocks.execFileSync("git")`, is not a spawn.
 *
 * Two limits it cannot check statically: a command held in a variable, and git spawned by code the
 * test calls, which this rule never sees.
 */
import type { RuleTester } from "oxlint/plugins-dev";

type Rule = Parameters<RuleTester["run"]>[1];
type Context = Parameters<Extract<Rule, { create: unknown }>["create"]>[0];
type Node = Parameters<Context["sourceCode"]["getScope"]>[0];
type Call = Extract<Node, { type: "CallExpression" }>;
type Import = Extract<Node, { type: "ImportDeclaration" }>;

type Names = {
  spawns: Set<string>;
  namespaces: Set<string>;
  helpers: Set<string>;
  helperNamespaces: Set<string>;
};

const SPAWNS = new Set(["exec", "execSync", "execFile", "execFileSync", "spawn", "spawnSync"]);
const HELPER = /(^|\/)git-env\.test-helper\.ts$/u;
const CHILD_PROCESS = /^(node:)?child_process$/u;
const GIT_COMMAND = /^([^\s]*\/)?git(\s|$)/u;

const MESSAGE =
  "Import isolateGitEnv() from git-env.test-helper.ts and call it in beforeEach: a git hook exports GIT_DIR, which points this git call at the pushing repository";

function commandText(argument: Node): string | undefined {
  if (argument.type === "Literal" && typeof argument.value === "string") return argument.value;
  if (argument.type === "TemplateLiteral") return argument.quasis[0]?.value.raw;
  return undefined;
}

function isSpawnMember(callee: Extract<Node, { type: "MemberExpression" }>, names: Names): boolean {
  const { object, property } = callee;
  if (object.type !== "Identifier" || property.type !== "Identifier") return false;
  return (
    SPAWNS.has(property.name) &&
    (object.name === "child_process" || names.namespaces.has(object.name))
  );
}

function isSpawnCallee(callee: Node, names: Names): boolean {
  if (callee.type === "Identifier") return SPAWNS.has(callee.name) || names.spawns.has(callee.name);
  return callee.type === "MemberExpression" && isSpawnMember(callee, names);
}

function spawnsGit(node: Call, names: Names): boolean {
  const [command] = node.arguments;
  if (command === undefined || !isSpawnCallee(node.callee, names)) return false;
  return GIT_COMMAND.test(commandText(command) ?? "");
}

function isIsolateCall(node: Call, names: Names): boolean {
  const { callee } = node;
  if (callee.type === "Identifier") return names.helpers.has(callee.name);
  if (callee.type !== "MemberExpression") return false;
  return (
    callee.object.type === "Identifier" &&
    names.helperNamespaces.has(callee.object.name) &&
    callee.property.type === "Identifier" &&
    callee.property.name === "isolateGitEnv"
  );
}

function beforeEachCallbacks(node: Call): Node[] {
  if (node.callee.type !== "Identifier" || node.callee.name !== "beforeEach") return [];
  return node.arguments.filter(
    (argument) =>
      argument.type === "ArrowFunctionExpression" || argument.type === "FunctionExpression",
  );
}

function recordImport(node: Import, names: Names): void {
  const source = node.source.value;
  for (const specifier of node.specifiers) {
    if (CHILD_PROCESS.test(source)) recordChildProcess(specifier, names);
    if (HELPER.test(source)) recordHelper(specifier, names);
  }
}

function recordChildProcess(specifier: Import["specifiers"][number], names: Names): void {
  if (specifier.type !== "ImportSpecifier") {
    names.namespaces.add(specifier.local.name);
    return;
  }
  if (specifier.imported.type === "Identifier" && SPAWNS.has(specifier.imported.name)) {
    names.spawns.add(specifier.local.name);
  }
}

function recordHelper(specifier: Import["specifiers"][number], names: Names): void {
  if (specifier.type === "ImportNamespaceSpecifier") {
    names.helperNamespaces.add(specifier.local.name);
  } else if (
    specifier.type === "ImportSpecifier" &&
    specifier.imported.type === "Identifier" &&
    specifier.imported.name === "isolateGitEnv"
  ) {
    names.helpers.add(specifier.local.name);
  }
}

function inside(inner: Node, outer: Node): boolean {
  return inner.range[0] >= outer.range[0] && inner.range[1] <= outer.range[1];
}

export const realGitEnvRule: Rule = {
  meta: {
    type: "problem",
    docs: { description: "Clear GIT_* variables in a test that runs real git" },
  },
  create(context) {
    const names: Names = {
      spawns: new Set(),
      namespaces: new Set(),
      helpers: new Set(),
      helperNamespaces: new Set(),
    };
    const gitCalls: Node[] = [];
    const isolateCalls: Node[] = [];
    const callbacks: Node[] = [];
    return {
      ImportDeclaration(node) {
        recordImport(node, names);
      },
      CallExpression(node) {
        if (spawnsGit(node, names)) gitCalls.push(node);
        if (isIsolateCall(node, names)) isolateCalls.push(node);
        callbacks.push(...beforeEachCallbacks(node));
      },
      "Program:exit"() {
        const cleared = isolateCalls.some((call) => callbacks.some((cb) => inside(call, cb)));
        if (cleared) return;
        for (const node of gitCalls) context.report({ node, message: MESSAGE });
      },
    };
  },
};
