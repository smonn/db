export function typeOf(node: object): string {
  const type: unknown = Reflect.get(node, "type");
  return typeof type === "string" ? type : "";
}

function functionDeclarationName(node: object): string | undefined {
  if (typeOf(node) !== "FunctionDeclaration") return undefined;
  const id: unknown = Reflect.get(node, "identifier");
  const name: unknown = typeof id === "object" && id !== null ? Reflect.get(id, "value") : null;
  return typeof name === "string" ? name : undefined;
}

function isFunctionValue(init: unknown): boolean {
  const type = typeOf(init ?? {});
  return type === "ArrowFunctionExpression" || type === "FunctionExpression";
}

function declaratorFunctionName(declarator: object): string | undefined {
  if (!isFunctionValue(Reflect.get(declarator, "init"))) return undefined;
  const id: unknown = Reflect.get(declarator, "id");
  const name: unknown = typeof id === "object" && id !== null ? Reflect.get(id, "value") : null;
  return typeof name === "string" ? name : undefined;
}

function variableFunctionNames(node: object): string[] {
  if (typeOf(node) !== "VariableDeclaration") return [];
  const declarations: unknown = Reflect.get(node, "declarations");
  if (!Array.isArray(declarations)) return [];
  const names: string[] = [];
  for (const declarator of declarations as readonly object[]) {
    const name = declaratorFunctionName(declarator);
    if (name !== undefined) names.push(name);
  }
  return names;
}

/** The names of the functions a module declares at its top level, exported or not. */
export function localFunctions(body: readonly object[]): Set<string> {
  const names = new Set<string>();
  const add = (node: unknown): void => {
    if (typeof node !== "object" || node === null) return;
    const declared = functionDeclarationName(node);
    if (declared !== undefined) names.add(declared);
    for (const name of variableFunctionNames(node)) names.add(name);
  };
  for (const item of body) {
    add(item);
    add(Reflect.get(item, "declaration"));
  }
  return names;
}
