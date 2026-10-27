import { expressionOf, rememberExpression } from "./index-expressions.ts";
import { METHOD_CAPABILITIES, indexNameOf, methodOf, type IndexMethod } from "./index-options.ts";
import { keyColumns, type RuntimeRefs } from "./table-keys.ts";

/** One key of an index. Postgres sorts NULLs last in an ascending key and first in a descending one. */
type IndexKey = ({ readonly column: string } | { readonly expression: string }) & {
  readonly descending: boolean;
  readonly nullsFirst: boolean;
};

/** An index the second callback's `indexes` declares. */
export type TableIndex = {
  /** The index name when the Definition gives one; the catalog derives it otherwise. */
  readonly name: string | undefined;
  /** In key order, which is the order the index sorts by. */
  readonly keys: readonly IndexKey[];
  readonly include: readonly string[];
  readonly method: IndexMethod;
  readonly unique: boolean;
  readonly nullsNotDistinct: boolean;
  /** The predicate of a partial index, as DDL text; `undefined` indexes every row. */
  readonly where: string | undefined;
};

const SHAPE =
  "The table's indexes takes a list of { columns, where?, include?, method?, unique?, nullsNotDistinct?, name? }";
const ENTRY_KEYS = new Set([
  "columns",
  "where",
  "include",
  "method",
  "unique",
  "nullsNotDistinct",
  "name",
]);
const WRAPPER_SHAPE =
  "A key in the table's indexes takes a column, an sql expression, or { key, order?, nulls? }";
const WRAPPER_KEYS = new Set(["key", "order", "nulls"]);

export function indexesOf(own: RuntimeRefs, declared: unknown): TableIndex[] {
  if (declared === undefined) return [];
  if (!Array.isArray(declared)) throw new TypeError(SHAPE);
  const entries: unknown[] = declared;
  return entries.map((entry) => indexOf(own, entry));
}

function indexOf(own: RuntimeRefs, entry: unknown): TableIndex {
  if (typeof entry !== "object" || entry === null) throw new TypeError(SHAPE);
  const unexpected = Object.keys(entry).find((key) => !ENTRY_KEYS.has(key));
  if (unexpected !== undefined) {
    throw new TypeError(`The table's indexes does not take "${unexpected}"; ${SHAPE}`);
  }
  const listed = listOf(entry, "columns").map((element) => keyOf(element));
  if (listed.length === 0) throw new Error("The table's indexes lists no columns");
  const name = indexNameOf(get(entry, "name"), "The table's indexes entry");
  const { keys, include } = keysOf(own, listed, listOf(entry, "include"));
  requireNameForExpressions(name, keys);
  const where = get(entry, "where");
  const index = {
    name,
    keys,
    include,
    method: methodOf(get(entry, "method"), "The table's indexes entry"),
    unique: flagOf(entry, "unique"),
    nullsNotDistinct: flagOf(entry, "nullsNotDistinct"),
    where: whereOf(own, where),
  };
  requireMethodSupport(index);
  rememberExpression(index, own, where);
  return index;
}

/** Postgres rejects these at Shadow with a raw error; refuse each option that would change the emitted SQL. */
function requireMethodSupport(index: TableIndex): void {
  const can = METHOD_CAPABILITIES[index.method];
  const uses: readonly (readonly [keyof typeof can, string, boolean])[] = [
    ["order", 'order "desc"', index.keys.some((key) => key.descending)],
    ["order", "nulls", index.keys.some((key) => key.nullsFirst !== key.descending)],
    ["include", "include", index.include.length > 0],
    ["unique", "unique", index.unique],
    ["unique", "nullsNotDistinct", index.nullsNotDistinct],
    ["multiColumn", "more than one column", index.keys.length > 1],
  ];
  const refused = uses.find(([capability, , used]) => used && !can[capability]);
  if (refused === undefined) return;
  throw new Error(
    `The table's indexes has ${describeIndex(index)} using the method "${index.method}", which does not take ${refused[1]}; Postgres would reject it at Shadow`,
  );
}

function describeIndex(index: TableIndex): string {
  if (index.name !== undefined) return `the index ${JSON.stringify(index.name)}`;
  // requireNameForExpressions already refused an unnamed index with an expression key
  // Stryker disable next-line MethodExpression: an unnamed index has no expression key, so the filter drops nothing.
  const columns = index.keys.filter((key) => "column" in key);
  return `the index on ${columns.map((key) => JSON.stringify(key.column)).join(", ")}`;
}

function requireNameForExpressions(name: string | undefined, keys: readonly IndexKey[]): void {
  if (name !== undefined || !keys.some((key) => "expression" in key)) return;
  throw new Error(
    "The table's indexes lists an expression key without a name; give the index its own name, since Postgres's default says nothing and collides",
  );
}

function whereOf(own: RuntimeRefs, given: unknown): string | undefined {
  if (given === undefined) return undefined;
  const text = expressionOf(own, given);
  if (text !== undefined) return text;
  throw new TypeError("The table's indexes takes where as an sql expression");
}

/** An expression key keeps its text; one pass checks every column ref and refuses a column named twice, across plain keys and INCLUDE alike. */
function keysOf(
  own: RuntimeRefs,
  listed: readonly ListedKey[],
  given: readonly unknown[],
): { keys: IndexKey[]; include: string[] } {
  const expressions = listed.map(({ ref }) => expressionOf(own, ref));
  const plain = listed.flatMap(({ ref }, at) => (expressions[at] === undefined ? [ref] : []));
  const columns = keyColumns(own, [...plain, ...given], "indexes");
  const keys = listed.map(({ ref, descending, nullsFirst }, at): IndexKey => {
    const expression = expressions[at];
    // Stryker disable next-line StringLiteral: columns holds a name for every plain key, so shift() finds one.
    if (expression === undefined) return { column: columns.shift() ?? "", descending, nullsFirst };
    const key = { expression, descending, nullsFirst };
    rememberExpression(key, own, ref);
    return key;
  });
  return { keys, include: columns };
}

function get(entry: object, key: string): unknown {
  const value: unknown = Reflect.get(entry, key);
  return value;
}

function listOf(entry: object, key: "columns" | "include"): unknown[] {
  const given = get(entry, key);
  if (given === undefined && key === "include") return [];
  if (Array.isArray(given)) return given;
  throw new TypeError(`The table's indexes takes ${key} as a list`);
}

function flagOf(entry: object, key: "unique" | "nullsNotDistinct"): boolean {
  const given = get(entry, key);
  if (given === undefined) return false;
  if (typeof given === "boolean") return given;
  throw new TypeError(`The table's indexes takes ${key} as a boolean`);
}

type ListedKey = { ref: unknown; descending: boolean; nullsFirst: boolean };

/** A key is a column ref or an sql expression, or `{ key, order, nulls }` around one. */
function keyOf(element: unknown): ListedKey {
  if (!isWrapped(element)) return { ref: element, descending: false, nullsFirst: false };
  return wrappedKeyOf(element);
}

function wrappedKeyOf(element: object): ListedKey {
  const unexpected = Object.keys(element).find((key) => !WRAPPER_KEYS.has(key));
  if (unexpected !== undefined) {
    throw new TypeError(
      `A key in the table's indexes does not take "${unexpected}"; ${WRAPPER_SHAPE}`,
    );
  }
  const descending = descendingOf(get(element, "order"));
  return {
    ref: get(element, "key"),
    descending,
    nullsFirst: nullsFirstOf(get(element, "nulls")) ?? descending,
  };
}

function isWrapped(element: unknown): element is object {
  if (typeof element !== "object" || element === null) return false;
  return !("~ref" in element) && !("toSql" in element) && "key" in element;
}

function descendingOf(order: unknown): boolean {
  if (order === undefined || order === "asc") return false;
  if (order === "desc") return true;
  throw new TypeError(`A key in the table's indexes takes order "asc" or "desc"`);
}

function nullsFirstOf(nulls: unknown): boolean | undefined {
  if (nulls === undefined) return undefined;
  if (nulls === "first" || nulls === "last") return nulls === "first";
  throw new TypeError(`A key in the table's indexes takes nulls "first" or "last"`);
}
