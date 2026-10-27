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
import { isIdentifier, isMember, named } from "./lint-ast.ts";

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
const CHILD_PROCESS = new Set(["child_process", "node:child_process"]);
const GIT_COMMAND = /^([^\s]*\/)?git(\s|$)/u;

const MESSAGE =
  "Import isolateGitEnv() from git-env.test-helper.ts and call it in beforeEach: a git hook exports GIT_DIR, which points this git call at the pushing repository";

/** Whether a command argument names git; a template's text before its first `${...}` must. */
function isGitCommand(argument: Node): boolean {
  if (argument.type === "Literal") return GIT_COMMAND.test(String(argument.value));
  return (
    argument.type === "TemplateLiteral" &&
    argument.quasis.some((quasi, index) => index === 0 && GIT_COMMAND.test(quasi.value.raw))
  );
}

function isSpawnCallee(callee: Node, names: Names): boolean {
  return (
    isIdentifier(callee, (name) => SPAWNS.has(name) || names.spawns.has(name)) ||
    (callee.type === "MemberExpression" &&
      isIdentifier(
        callee.object,
        (name) => name === "child_process" || names.namespaces.has(name),
      ) &&
      isIdentifier(callee.property, (name) => SPAWNS.has(name)))
  );
}

function spawnsGit(node: Call, names: Names): boolean {
  const [command] = node.arguments;
  return command !== undefined && isSpawnCallee(node.callee, names) && isGitCommand(command);
}

function isIsolateCall(node: Call, names: Names): boolean {
  return (
    isIdentifier(node.callee, (name) => names.helpers.has(name)) ||
    isMember(node.callee, (name) => names.helperNamespaces.has(name), named("isolateGitEnv"))
  );
}

function isBeforeEachCallback(node: Node): boolean {
  return (
    (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression") &&
    node.parent.type === "CallExpression" &&
    isIdentifier(node.parent.callee, named("beforeEach"))
  );
}

function inBeforeEach(node: Node): boolean {
  for (let current: Node | null = node; current !== null; current = current.parent) {
    if (isBeforeEachCallback(current)) return true;
  }
  return false;
}

function recordImport(node: Import, names: Names): void {
  const source = node.source.value;
  for (const specifier of node.specifiers) {
    if (CHILD_PROCESS.has(source)) recordChildProcess(specifier, names);
    if (HELPER.test(source)) recordHelper(specifier, names);
  }
}

function recordChildProcess(specifier: Import["specifiers"][number], names: Names): void {
  if (specifier.type !== "ImportSpecifier") {
    names.namespaces.add(specifier.local.name);
    return;
  }
  if (isIdentifier(specifier.imported, (name) => SPAWNS.has(name))) {
    names.spawns.add(specifier.local.name);
  }
}

function recordHelper(specifier: Import["specifiers"][number], names: Names): void {
  if (specifier.type === "ImportNamespaceSpecifier") {
    names.helperNamespaces.add(specifier.local.name);
  } else if (
    specifier.type === "ImportSpecifier" &&
    isIdentifier(specifier.imported, named("isolateGitEnv"))
  ) {
    names.helpers.add(specifier.local.name);
  }
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
    let cleared = false;
    return {
      ImportDeclaration(node) {
        recordImport(node, names);
      },
      CallExpression(node) {
        if (spawnsGit(node, names)) gitCalls.push(node);
        if (isIsolateCall(node, names) && inBeforeEach(node)) cleared = true;
      },
      "Program:exit"() {
        if (cleared) return;
        for (const node of gitCalls) context.report({ node, message: MESSAGE });
      },
    };
  },
};
