import type { ScalarClass, SqlClass, Table } from "../definition/index.ts";
import { fragment, identifier, join, type Fragment } from "../sql/index.ts";
import { encodeElement, encodeList, encodeValue } from "./codecs.ts";
import { expr, sortable, termOf, type Expr, type Ordering, type Sortable } from "./expr.ts";

type Column = Table["columns"][string];

/** A boolean SQL expression, built from column comparisons and the `and`, `or`, `not` exports. */
export type Predicate = Expr<boolean>;

type NullChecks = {
  isNull(): Predicate;
  isNotNull(): Predicate;
};

/** What `select` needs from a column; every ColumnRef is one. */
type SelectableColumn<V> = {
  readonly name: string;
  /** Type-only: the value this column yields when selected. */
  readonly "~value"?: V;
};

/** An array column takes `includes` in place of these: `= any($1)` would compare the array with each item. */
type SetMatches<V> = {
  in(values: readonly NonNullable<V>[]): Predicate;
  notIn(values: readonly NonNullable<V>[]): Predicate;
};

/** An array column's element, as `includes` takes it: NULL never matches. */
type Element<V> = NonNullable<V> extends readonly (infer E)[] ? NonNullable<E> : never;

type ArrayMatches<V> = { includes(value: Element<V>): Predicate };

type PatternMatches = {
  like(pattern: string): Predicate;
  ilike(pattern: string): Predicate;
};

/**
 * `S` is the column's SQL type class. Each test wraps it in a tuple, so a union such as the
 * default offers a call only when every member does.
 */
export type ColumnRef<V, S extends SqlClass = SqlClass> = SelectableColumn<V> &
  Sortable<V> &
  (null extends V ? NullChecks : unknown) &
  ([S] extends [ScalarClass] ? SetMatches<V> : unknown) &
  ([S] extends [`${string}[]`] ? ArrayMatches<V> : unknown) &
  ([S] extends ["text"] ? PatternMatches : unknown) & {
    eq(value: NonNullable<V>): Predicate;
    ne(value: NonNullable<V>): Predicate;
    gt(value: NonNullable<V>): Predicate;
    gte(value: NonNullable<V>): Predicate;
    lt(value: NonNullable<V>): Predicate;
    lte(value: NonNullable<V>): Predicate;
  };

/** The SQL type class of each key of a row `R`. */
export type Classes<R> = { readonly [K in keyof R]: SqlClass };

/** Typed over the row and its classes, not its Table, so an error prints the row's keys. */
export type Refs<R, C extends Classes<R> = Classes<R>> = {
  readonly [K in keyof R & string]: ColumnRef<R[K], C[K]>;
};

/** Each value is a column or an Expr, under the key that names its output. */
export type Selection = Record<string, SelectableColumn<unknown> | Expr>;

export type Selected<S extends Selection> = {
  -readonly [K in keyof S]: S[K] extends Expr<infer V>
    ? V
    : S[K] extends SelectableColumn<infer V>
      ? V
      : never;
};

/** The column a ref reads: key `key` of `table`, which a joined query qualifies by `alias`. */
export type ColumnSource = { readonly table: Table; readonly key: string; readonly alias: string };

/** What `orderBy` takes: an ordering, or a bare column or Expr, which sorts ascending. */
export type Orderable = Ordering | SelectableColumn<unknown> | Expr;

const predicate: (render: () => Fragment) => Predicate = expr;

/** The column each ref reads, so a template, `select`, and `orderBy` can tell a ref from a value. */
const refSources = new WeakMap<object, ColumnSource>();

/** What every ref carries at run time; `Refs` hides the calls a column's class can't take. */
type AnyRef = ColumnRef<string | null, "text"> & { includes(value: string): Predicate };

function refOf(source: ColumnSource, definition: Column): AnyRef {
  const { table, key: name } = source;
  const column = columnIdentifier(table, name);
  const compare = (operator: Fragment, value: unknown) =>
    predicate(() => fragment`${column} ${operator} ${encodeValue(table, name, value)}`);
  const ref: AnyRef = {
    name,
    eq: (value) => compare(fragment`=`, value),
    ne: (value) => compare(fragment`<>`, value),
    gt: (value) => compare(fragment`>`, value),
    gte: (value) => compare(fragment`>=`, value),
    lt: (value) => compare(fragment`<`, value),
    lte: (value) => compare(fragment`<=`, value),
    in: (values) =>
      predicate(() => fragment`${column} = any(${encodeList(table, name, definition, values)})`),
    notIn: (values) =>
      predicate(() => fragment`${column} <> all(${encodeList(table, name, definition, values)})`),
    includes: (value) =>
      predicate(() => fragment`${encodeElement(table, name, value)} = any(${column})`),
    like: (pattern) => predicate(() => fragment`${column} like ${pattern}`),
    ilike: (pattern) => predicate(() => fragment`${column} ilike ${pattern}`),
    ...sortable(() => column),
    isNull: () => predicate(() => fragment`${column} is null`),
    isNotNull: () => predicate(() => fragment`${column} is not null`),
  };
  refSources.set(ref, source);
  return ref;
}

/** The column `value` reads; `undefined` for a value that is no ref. */
export function sourceOf(value: unknown): ColumnSource | undefined {
  return typeof value === "object" && value !== null ? refSources.get(value) : undefined;
}

export function columnSql({ table, key }: ColumnSource): Fragment {
  return columnIdentifier(table, key);
}

/** The SQL a ref renders inside a template, the same its comparisons render; `undefined` for a value that is no ref. */
export function refSql(value: unknown): Fragment | undefined {
  const source = sourceOf(value);
  return source === undefined ? undefined : columnSql(source);
}

export function refsOf<R>(table: Table, alias: string = table.name): Refs<R> {
  const refs = Object.fromEntries(
    Object.entries(table.columns).map(([key, definition]) => [
      key,
      refOf({ table, key, alias }, definition),
    ]),
  );
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Object.fromEntries loses the keys.
  return refs as unknown as Refs<R>;
}

function combine(separator: Fragment, terms: readonly Expr<boolean | null>[]): Predicate {
  return predicate(() => {
    const inner = join(
      terms.map((term) => termOf(term)),
      separator,
    );
    return fragment`(${inner})`;
  });
}

export function and(first: Expr<boolean | null>, ...rest: Expr<boolean | null>[]): Predicate {
  return combine(fragment` and `, [first, ...rest]);
}

export function or(first: Expr<boolean | null>, ...rest: Expr<boolean | null>[]): Predicate {
  return combine(fragment` or `, [first, ...rest]);
}

export function not(term: Expr<boolean | null>): Predicate {
  return predicate(() => fragment`not (${term["~expr"]()})`);
}

/** The column of key `key` as SQL names it, once `defineDatabase` mapped it. */
export function columnIdentifier(table: Table, key: string): Fragment {
  return identifier(table.columnNames[key] ?? key);
}
