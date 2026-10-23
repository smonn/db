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

/** Node types that run code, or change state, whenever they are reached outside a function body. */
const EFFECT_TYPES = new Set([
  "TaggedTemplateExpression",
  "AwaitExpression",
  "AssignmentExpression",
  "UpdateExpression",
  "StaticBlock",
  "ExpressionStatement",
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
  if (type === "NewExpression") return pureConstructor(node) ? null : type;
  if (type === "ImportDeclaration") {
    const specifiers: unknown = Reflect.get(node, "specifiers");
    return Array.isArray(specifiers) && specifiers.length === 0 ? type : null;
  }
  if (type === "UnaryExpression") return Reflect.get(node, "operator") === "delete" ? type : null;
  return EFFECT_TYPES.has(type) ? type : null;
}

/** The node's source, collapsed to one line and cut to about 80 characters. */
function snippet(node: object, bytes: Buffer, base: number): string {
  const span: unknown = Reflect.get(node, "span");
  const start: unknown = typeof span === "object" && span !== null ? Reflect.get(span, "start") : 0;
  const end: unknown = typeof span === "object" && span !== null ? Reflect.get(span, "end") : 0;
  if (typeof start !== "number" || typeof end !== "number") return "";
  const text = bytes
    .subarray(start - base, end - base)
    .toString("utf8")
    .replaceAll(/\s+/gu, " ")
    .trim();
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

type Source = {
  readonly bytes: Buffer;
  readonly base: number;
};

function walk(node: unknown, local: ReadonlySet<string>, source: Source, found: string[]): void {
  if (typeof node !== "object" || node === null) return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, local, source, found);
    return;
  }
  if (DEFERRED.has(typeOf(node))) return;
  const effect = effectOf(node, local);
  if (effect !== null) found.push(`${effect}: ${snippet(node, source.bytes, source.base)}`);
  for (const value of Object.values(node)) walk(value, local, source, found);
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
 * What a built module runs when it loads, each as `Type: source`: an expression statement at any
 * depth, a bare `import "x"`, a class static block, an assignment, update, or `delete`, or a
 * `new`, tagged template, `await`, or call outside a function body. Declarations, named imports,
 * exports, and literals run nothing. A call to a function the module declares itself is allowed
 * inside an initializer, such as `const RULES = { drop: always("data_loss") }`; as a statement it
 * still counts. This is a static check, so it does not follow what a local function does.
 */
export function topLevelEffects(source: string): string[] {
  const module = parseSync(source, { syntax: "ecmascript", target: "es2022" });
  const local = localFunctions(module.body);
  const found: string[] = [];
  // swc's spans are byte offsets that start at the module's own span, not at zero.
  walk(module.body, local, { bytes: Buffer.from(source), base: module.span.start }, found);
  return found;
}
