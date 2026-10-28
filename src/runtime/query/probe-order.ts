import type { ColumnKind, Table } from "../definition/index.ts";
import { elementText, formatArrayLiteral } from "../internal/index.ts";
import { fragment, join, type Fragment } from "../sql/index.ts";
import { elementSqlType } from "./array-text.ts";
import { encodeValue } from "./codecs.ts";

/** `from.ts`'s Predicate, restated so the probe doesn't import from it (no-cycles). */
type Predicate = { readonly "~predicate": () => Fragment };

/** One `order by` term: a column and its direction, from `u.x.asc()` or `u.x.desc()`. */
export type Ordering = { readonly "~ordering": () => Fragment };

export type NullsOption = { readonly nulls: "first" | "last" };

/**
 * A NOT NULL column refuses `nulls`, as it has no `isNull`. The inline key spells the reason, so
 * passing `{ nulls }` prints it beside the bad key instead of "Expected 0 arguments".
 */
export type OrderingMethods<V> = null extends V
  ? { asc(options?: NullsOption): Ordering; desc(options?: NullsOption): Ordering }
  : {
      asc(options?: { readonly "nulls needs a nullable column"?: never }): Ordering;
      desc(options?: { readonly "nulls needs a nullable column"?: never }): Ordering;
    };

/** Not on an array column: Postgres has no array of arrays to compare one with. */
export type SetMethods<V> = {
  /** `col = any($1)`; an empty list matches no row. */
  in(values: readonly NonNullable<V>[]): Predicate;
  /** `col <> all($1)`; an empty list matches every row, NULL ones too. */
  notIn(values: readonly NonNullable<V>[]): Predicate;
};

export type TextMethods = {
  like(pattern: string): Predicate;
  ilike(pattern: string): Predicate;
};

type ElementOf<V> = NonNullable<V> extends readonly (infer E)[] ? NonNullable<E> : never;

export type ArrayMethods<V> = { includes(value: ElementOf<V>): Predicate };

/** The methods a column's kind adds to its ref. */
export type KindMethods<V, K extends ColumnKind> = K extends "array"
  ? ArrayMethods<V>
  : (K extends "text" ? TextMethods : unknown) & SetMethods<V>;

/** Reads the kind a column's `"~types"` carries. */
export type KindOf<Col> = Col extends { readonly "~types": { readonly kind: infer K } }
  ? K extends ColumnKind
    ? K
    : "other"
  : "other";

/** Anything `orderBy` takes: an ordering, or a bare column meaning ascending. */
export type OrderTerm = Ordering | { readonly name: string; readonly asc: () => Ordering };

const predicate = (piece: () => Fragment): Predicate => ({ "~predicate": piece });

function isOrdering(term: unknown): term is Ordering {
  return (
    typeof term === "object" &&
    term !== null &&
    typeof Reflect.get(term, "~ordering") === "function"
  );
}

function nullsOf(options: unknown): Fragment {
  if (options === undefined) return fragment``;
  const nulls: unknown =
    typeof options === "object" && options !== null ? Reflect.get(options, "nulls") : options;
  if (nulls === "first") return fragment` nulls first`;
  if (nulls === "last") return fragment` nulls last`;
  throw new Error(`nulls takes "first" or "last", got ${JSON.stringify(nulls)}`);
}

type Directions = { asc(options?: NullsOption): Ordering; desc(options?: NullsOption): Ordering };

export function orderingMethods(column: Fragment): Directions {
  const order =
    (direction: Fragment) =>
    (options?: NullsOption): Ordering => {
      const nulls = nullsOf(options);
      return { "~ordering": () => fragment`${column} ${direction}${nulls}` } satisfies Ordering;
    };
  return { asc: order(fragment`asc`), desc: order(fragment`desc`) };
}

/** Turns what an `orderBy` callback returned into its terms, refusing anything else by name. */
export function orderingsOf(picked: unknown): Ordering[] {
  const terms: readonly unknown[] = Array.isArray(picked) ? picked : [picked];
  if (terms.length === 0) throw new Error("orderBy needs at least one column");
  return terms.map((term) => orderingOf(term));
}

function describe(term: unknown): string {
  if (typeof term !== "object" || term === null) return typeof term;
  return "~predicate" in term ? "a predicate" : "an object";
}

function orderingOf(term: unknown): Ordering {
  if (isOrdering(term)) return term;
  const asc: unknown = typeof term === "object" && term !== null ? Reflect.get(term, "asc") : 0;
  const ordering: unknown = typeof asc === "function" ? Reflect.apply(asc, term, []) : undefined;
  if (isOrdering(ordering)) return ordering;
  throw new Error(`orderBy takes a column, column.asc(), or column.desc(), got ${describe(term)}`);
}

export function renderOrderBy(orderings: readonly Ordering[]): Fragment {
  if (orderings.length === 0) return fragment``;
  return fragment` order by ${join(
    orderings.map((term) => term["~ordering"]()),
    fragment`, `,
  )}`;
}

/** Runtime check, since a fraction or a negative count only fails on the server. */
export function countOf(clause: "limit" | "offset", count: unknown): number {
  if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) return count;
  throw new Error(`${clause} takes a non-negative safe integer, got ${String(count)}`);
}

export function renderPaging(limit: number | undefined, offset: number | undefined): Fragment {
  const limitPart = limit === undefined ? fragment`` : fragment` limit ${limit}`;
  const offsetPart = offset === undefined ? fragment`` : fragment` offset ${offset}`;
  return fragment`${limitPart}${offsetPart}`;
}

const jsonTypes = new Set(["json", "jsonb"]);

/**
 * The list as array text, each element through the column's codec, as an array column's value is
 * sent (ADR-0023). Untyped, the param takes the array type of the column it meets, so an enum or
 * domain needs no cast, even on a connection opened before the type existed.
 */
function listText(table: Table, key: string, values: readonly unknown[]): string {
  if (!Array.isArray(values)) throw new Error(`in takes an array, got ${typeof values}`);
  const definition = table.columns[key];
  const format =
    definition !== undefined && jsonTypes.has(elementSqlType(definition))
      ? (element: unknown) => JSON.stringify(element)
      : elementText;
  const encoded = values.map((value: unknown) => {
    if (value === null || value === undefined) throw new Error("in takes no null; use isNull()");
    return encodeValue(table, key, value);
  });
  return formatArrayLiteral(encoded, format);
}

export function setMethods(
  table: Table,
  key: string,
  column: Fragment,
): Record<"in" | "notIn", (values: readonly unknown[]) => Predicate> {
  return {
    in: (values: readonly unknown[]) =>
      predicate(() => fragment`${column} = any(${listText(table, key, values)})`),
    notIn: (values: readonly unknown[]) =>
      predicate(() => fragment`${column} <> all(${listText(table, key, values)})`),
  };
}

export function textMethods(
  column: Fragment,
): Record<"like" | "ilike", (pattern: string) => Predicate> {
  // The pattern skips the codec: it is SQL pattern text, not a column value.
  const match =
    (operator: Fragment) =>
    (pattern: string): Predicate => {
      if (typeof pattern !== "string")
        throw new Error(`like takes a string, got ${typeof pattern}`);
      return predicate(() => fragment`${column} ${operator} ${pattern}`);
    };
  return { like: match(fragment`like`), ilike: match(fragment`ilike`) };
}

export function arrayMethods(
  table: Table,
  key: string,
  column: Fragment,
): Record<"includes", (value: unknown) => Predicate> {
  return {
    includes: (value: unknown) =>
      predicate(() => fragment`${encodeValue(table, key, value)} = any(${column})`),
  };
}
