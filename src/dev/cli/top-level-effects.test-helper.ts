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
  "Constructor",
]);

/** Method nodes, in a class or an object literal: the body is deferred, but a computed key is not. */
const METHODS = new Set([
  "ClassMethod",
  "PrivateMethod",
  "GetterProperty",
  "SetterProperty",
  "MethodProperty",
]);

/** Class field nodes: a non-static one runs at construction, a static one when the class is defined. */
const FIELDS = new Set(["ClassProperty", "PrivateProperty"]);

const PURE_ANNOTATION = /\/\*\s*[@#]__PURE__\s*\*\/$/u;

const STRING_LITERAL = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/gu;

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

/**
 * Whether a `/* @__PURE__ *\/` or `/*#__PURE__*\/` block comment sits right before the node. A line
 * comment that ends in the text does not count, nor does the node when it starts at the same
 * offset as the call or `new` around it: bundlers honor the annotation on the outermost one only.
 */
function markedPure(node: object, source: Source, outerStart: number): boolean {
  const span: unknown = Reflect.get(node, "span");
  const start: unknown = typeof span === "object" && span !== null ? Reflect.get(span, "start") : 0;
  if (typeof start !== "number" || start === outerStart) return false;
  const before = source.bytes
    .subarray(0, start - source.base)
    .toString("utf8")
    .trimEnd();
  const match = PURE_ANNOTATION.exec(before);
  if (match === null) return false;
  const line = before.slice(before.lastIndexOf("\n", match.index) + 1, match.index);
  return !line.replaceAll(STRING_LITERAL, "").includes("//");
}

function effectOf(node: object, source: Source, outerStart: number): string | null {
  const type = typeOf(node);
  if (type === "CallExpression") {
    const name = calleeName(node);
    return (name !== undefined && source.local.has(name)) || markedPure(node, source, outerStart)
      ? null
      : type;
  }
  if (type === "NewExpression") {
    return pureConstructor(node) || markedPure(node, source, outerStart) ? null : type;
  }
  if (type === "ImportDeclaration") {
    const specifiers: unknown = Reflect.get(node, "specifiers");
    return Array.isArray(specifiers) && specifiers.length === 0 ? type : null;
  }
  if (type === "UnaryExpression") return Reflect.get(node, "operator") === "delete" ? type : null;
  return EFFECT_TYPES.has(type) ? type : null;
}

type Source = {
  readonly bytes: Buffer;
  readonly base: number;
  readonly local: ReadonlySet<string>;
};

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

function startOf(node: object): number {
  const span: unknown = Reflect.get(node, "span");
  const start: unknown =
    typeof span === "object" && span !== null ? Reflect.get(span, "start") : -1;
  return typeof start === "number" ? start : -1;
}

/** `outerStart` is where the nearest enclosing call or `new` begins, or -1 outside one. */
function walk(node: unknown, source: Source, found: string[], outerStart = -1): void {
  if (typeof node !== "object" || node === null) return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, source, found, outerStart);
    return;
  }
  if (DEFERRED.has(typeOf(node))) return;
  if (METHODS.has(typeOf(node))) {
    walk(Reflect.get(node, "key"), source, found, outerStart);
    return;
  }
  if (FIELDS.has(typeOf(node)) && Reflect.get(node, "isStatic") !== true) {
    // The value runs at construction, but a computed key is evaluated when the class is defined.
    walk(Reflect.get(node, "key"), source, found, outerStart);
    return;
  }
  const effect = effectOf(node, source, outerStart);
  if (effect !== null) found.push(`${effect}: ${snippet(node, source.bytes, source.base)}`);
  const type = typeOf(node);
  const next = type === "CallExpression" || type === "NewExpression" ? startOf(node) : outerStart;
  for (const value of Object.values(node)) walk(value, source, found, next);
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
 *
 * Skipped because it does not run at load: function, method, accessor, and constructor bodies, and
 * the value of a non-static class field, public or private, which runs at construction. A computed
 * key of such a field or method, in a class or an object literal, is evaluated when the class or
 * object is defined, so it still counts. A call or `new`
 * right after a `/* @__PURE__ *\/` or `/*#__PURE__*\/` block comment passes, since the bundler keeps
 * that annotation as the author wrote it and may drop an unused call on its strength. The bundler
 * proves nothing, so this trusts the author, not the compiler. Only the outermost call or `new` at
 * that position is covered: in `/* @__PURE__ *\/ make()()` the inner `make()` still runs at load.
 * Its arguments still count.
 *
 * Still flagged, on purpose:
 * - A static class field value, public or private. It runs when the class is defined.
 * - A call to an imported function, such as `const p = join("a", "b")`. A static check cannot see
 *   what the import does, and even a pure helper may move into a shared chunk. Mark it
 *   `/* @__PURE__ *\/` where it is safe, or call it inside a function.
 * - A tagged template, such as a constant `sql` template. The tag is a call, so it has the same
 *   blind spot as an imported function.
 */
export function topLevelEffects(source: string): string[] {
  // swc's spans are byte offsets from a base that grows with each parse, and the module's span
  // starts at its first token. A lead `;` is that token, so the base is where `prepared` begins. A
  // shebang is only valid at the very start, so `//` takes its place at the same length.
  const prepared = `;${source.replace(/^#!/u, "//")}`;
  const module = parseSync(prepared, { syntax: "ecmascript", target: "es2022" });
  const found: string[] = [];
  const context: Source = {
    bytes: Buffer.from(prepared),
    base: module.span.start,
    local: localFunctions(module.body),
  };
  walk(module.body, context, found);
  return found;
}
