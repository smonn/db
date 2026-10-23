import { parseSync } from "@swc/core";

/** Built-in constructors that build a value and do nothing else, so a module may call them at load. */
const PURE_CONSTRUCTORS = new Set([
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "RegExp",
  "TextEncoder",
  "TextDecoder",
]);

/** Nodes whose body runs only when called, not when the module loads. */
const DEFERRED = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "ClassMethod",
  "PrivateMethod",
  "Constructor",
  "GetterProperty",
  "SetterProperty",
  "MethodProperty",
]);

function typeOf(node: object): string {
  const type: unknown = Reflect.get(node, "type");
  return typeof type === "string" ? type : "";
}

function calleeName(node: object): string | undefined {
  const callee: unknown = Reflect.get(node, "callee");
  const name: unknown =
    typeof callee === "object" && callee !== null ? Reflect.get(callee, "value") : undefined;
  return typeof name === "string" ? name : undefined;
}

function pureConstructor(node: object): boolean {
  const name = calleeName(node);
  return name !== undefined && PURE_CONSTRUCTORS.has(name);
}

function effectOf(node: object, local: ReadonlySet<string>): string | null {
  const type = typeOf(node);
  if (type === "CallExpression") {
    const name = calleeName(node);
    return name !== undefined && local.has(name) ? null : type;
  }
  if (type === "TaggedTemplateExpression" || type === "AwaitExpression") return type;
  if (type === "NewExpression" && !pureConstructor(node)) return type;
  return null;
}

function walk(node: unknown, local: ReadonlySet<string>, found: string[]): void {
  if (typeof node !== "object" || node === null) return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, local, found);
    return;
  }
  if (DEFERRED.has(typeOf(node))) return;
  const effect = effectOf(node, local);
  if (effect !== null) found.push(effect);
  for (const value of Object.values(node)) walk(value, local, found);
}

/** The names of the functions a module declares at its top level, exported or not. */
function localFunctions(body: readonly object[]): Set<string> {
  const names = new Set<string>();
  const add = (node: unknown): void => {
    if (typeof node !== "object" || node === null) return;
    if (typeOf(node) === "FunctionDeclaration") {
      const id: unknown = Reflect.get(node, "identifier");
      const name: unknown = typeof id === "object" && id !== null ? Reflect.get(id, "value") : null;
      if (typeof name === "string") names.add(name);
    }
    if (typeOf(node) === "VariableDeclaration") {
      const declarations: unknown = Reflect.get(node, "declarations");
      if (Array.isArray(declarations)) {
        for (const declarator of declarations) {
          const init: unknown = Reflect.get(declarator, "init");
          const id: unknown = Reflect.get(declarator, "id");
          const isFunction =
            typeOf(init ?? {}) === "ArrowFunctionExpression" ||
            typeOf(init ?? {}) === "FunctionExpression";
          const name: unknown =
            typeof id === "object" && id !== null ? Reflect.get(id, "value") : null;
          if (isFunction && typeof name === "string") names.add(name);
        }
      }
    }
  };
  for (const item of body) {
    add(item);
    add(Reflect.get(item, "declaration"));
  }
  return names;
}

/**
 * What a built module runs when it loads: an expression statement, or a `new`, tagged template,
 * `await`, or call outside a function body. Declarations, imports, exports, and literals run
 * nothing. A call to a function the module declares itself is allowed inside an initializer, such
 * as `const RULES = { drop: always("data_loss") }`; as a statement it still counts. This is a
 * static check, so it does not follow what a local function does.
 */
export function topLevelEffects(source: string): string[] {
  const { body } = parseSync(source, { syntax: "ecmascript", target: "es2022" });
  const local = localFunctions(body);
  const found: string[] = [];
  for (const item of body) {
    if (item.type === "ExpressionStatement") found.push("ExpressionStatement");
    walk(item, local, found);
  }
  return found;
}
