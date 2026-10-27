/**
 * A Stryker ignorer plugin, loaded through `plugins` and `ignorers` in `stryker.config.mjs`. It
 * ignores the two shapes in `scripts/` whose mutants no in-process test can reach, and nothing else:
 *
 * - A script's entry guard: a top-level `if (import.meta.main)` with no `else`, whose body is
 *   exactly one call to `main(...)` or `await main(...)`, bare or alone in a block. Under the test
 *   runner `import.meta.main` is false, and Stryker doesn't instrument the child process a test
 *   would spawn to run the script. Stryker ignores a node's descendants too, so a guard that did
 *   more than call `main` would hide that code from mutation.
 * - A lint rule's `meta`: a `meta: { ... }` property of an object literal that also has a `create`
 *   method or a `create` property holding a function. Neither oxlint's RuleTester nor a rule's
 *   reports read the fields these rules set.
 *
 * Stryker hands `shouldIgnore` a Babel `NodePath`, of which this reads only `node` and `parent`.
 * It checks no more node types than it needs to tell these shapes apart from valid code, since
 * every extra check would be a mutant no test can kill.
 */

type Node = { readonly type: string; readonly [field: string]: unknown };

export type NodePath = { readonly node: Node; readonly parent: Node | null };

function field(value: unknown, key: string): unknown {
  return value instanceof Object ? Reflect.get(value, key) : undefined;
}

const isNode = (value: unknown, type: string): boolean => field(value, "type") === type;
const hasName = (value: unknown, name: string): boolean => field(value, "name") === name;

/** `import.meta.main` exactly, not `import.meta[main]` or `import.meta?.main`. */
function isImportMetaMain(value: unknown): boolean {
  const object = field(value, "object");
  return (
    isNode(value, "MemberExpression") &&
    field(value, "computed") === false &&
    // `import.meta` is the one meta property named `meta`.
    isNode(object, "MetaProperty") &&
    hasName(field(object, "property"), "meta") &&
    hasName(field(value, "property"), "main")
  );
}

/** `main(...)`, not `main?.()` or `x.main()`. */
function isMainCall(value: unknown): boolean {
  return isNode(value, "CallExpression") && hasName(field(value, "callee"), "main");
}

/** A statement that is `main(...)` or `await main(...)`. */
function isMainStatement(value: unknown): boolean {
  const expression = field(value, "expression");
  return (
    isNode(value, "ExpressionStatement") &&
    (isMainCall(expression) ||
      (isNode(expression, "AwaitExpression") && isMainCall(field(expression, "argument"))))
  );
}

/** The one statement a guard may run, bare or alone in a block. */
function isOnlyMainCall(consequent: unknown): boolean {
  const body = field(consequent, "body");
  return isNode(consequent, "BlockStatement")
    ? Array.isArray(body) && body.length === 1 && isMainStatement(body[0])
    : isMainStatement(consequent);
}

/** Only an `if` has a `test` and a null `alternate` directly in a Program. */
function isEntryGuard({ node, parent }: NodePath): boolean {
  return (
    field(node, "alternate") === null &&
    isNode(parent, "Program") &&
    isImportMetaMain(field(node, "test")) &&
    isOnlyMainCall(field(node, "consequent"))
  );
}

const hasKey = (value: unknown, name: string): boolean =>
  field(value, "computed") === false && hasName(field(value, "key"), name);

const isFunction = (value: unknown): boolean =>
  isNode(value, "FunctionExpression") || isNode(value, "ArrowFunctionExpression");

/** A `create() {}` method, or a `create` property holding a function. */
const isCreate = (value: unknown): boolean =>
  hasKey(value, "create") && (isNode(value, "ObjectMethod") || isFunction(field(value, "value")));

/** Only an object literal's property has a key, an object literal value, and siblings. */
function isRuleMeta({ node, parent }: NodePath): boolean {
  const siblings = field(parent, "properties");
  return (
    hasKey(node, "meta") &&
    isNode(field(node, "value"), "ObjectExpression") &&
    Array.isArray(siblings) &&
    siblings.some((sibling) => isCreate(sibling))
  );
}

export function shouldIgnore(path: NodePath): string | undefined {
  if (isEntryGuard(path)) {
    return "Entry guard: import.meta.main is false under the test runner, and Stryker doesn't instrument the child process that runs the script";
  }
  if (isRuleMeta(path)) {
    return "Lint rule meta: neither RuleTester nor the rule's reports read it, so no test can observe a change";
  }
  return undefined;
}

type IgnorePlugin = {
  readonly kind: "Ignore";
  readonly name: string;
  readonly value: { readonly shouldIgnore: typeof shouldIgnore };
};

export const strykerPlugins: readonly IgnorePlugin[] = [
  { kind: "Ignore", name: "unreachable-in-tests", value: { shouldIgnore } },
];
