import { expressionOf, rememberExpression } from "./index-expressions.ts";
import { indexNameOf, methodOf, type IndexMethod } from "./index-options.ts";
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
  if (name === undefined && keys.some((key) => "expression" in key)) {
    throw new Error(
      "The table's indexes lists an expression key without a name; give the index its own name, since Postgres's default says nothing and collides",
    );
  }
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
  if (where !== undefined) rememberExpression(index, own, where);
  return index;
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
  const wrapped =
    typeof element === "object" &&
    element !== null &&
    !("~ref" in element) &&
    !("toSql" in element) &&
    "key" in element;
  if (!wrapped) return { ref: element, descending: false, nullsFirst: false };
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
