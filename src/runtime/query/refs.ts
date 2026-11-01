import type { ScalarClass, SqlClass, Table } from "../definition/index.ts";
import { fragment, identifier, join, type Fragment } from "../sql/index.ts";
import { isTextArray } from "./array-text.ts";
import {
  decoderFor,
  encodeElement,
  encodeList,
  encodeValue,
  withDecoder,
  type Decode,
} from "./codecs.ts";
import { expr, isExpr, sortable, termOf, type Expr, type Ordering, type Sortable } from "./expr.ts";
import { brand, type Query } from "./statement.ts";

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

// Distribute over a conditional selection's column and Expr alternatives.
type SelectedValue<S> =
  S extends Expr<infer V> ? V : S extends SelectableColumn<infer V> ? V : never;

export type Selected<S extends Selection> = {
  -readonly [K in keyof S]: SelectedValue<S[K]>;
};

/** An output reads a column, by its key, or an Expr. */
export type Output = readonly [alias: string, source: string | Expr];

/** What `orderBy` takes: an ordering, or a bare column or Expr, which sorts ascending. */
export type Orderable = Ordering | SelectableColumn<unknown> | Expr;

const predicate: (render: () => Fragment) => Predicate = expr;

/** How each ref renders in a template, the same SQL its comparisons render. */
const refColumns = new WeakMap<object, Fragment>();

/** What every ref carries at run time; `Refs` hides the calls a column's class can't take. */
type AnyRef = ColumnRef<string | null, "text"> & { includes(value: string): Predicate };

function refOf(table: Table, name: string, definition: Column): AnyRef {
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
  refColumns.set(ref, column);
  return ref;
}

/** The SQL a ref renders inside a template; `undefined` for a value that is no ref. */
export function refSql(value: unknown): Fragment | undefined {
  return typeof value === "object" && value !== null ? refColumns.get(value) : undefined;
}

export function refsOf<R>(table: Table): Refs<R> {
  const refs = Object.fromEntries(
    Object.entries(table.columns).map(([name, definition]) => [
      name,
      refOf(table, name, definition),
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

/** The `order by` list of `terms`, in the order given. */
export function renderOrderBy(table: Table, terms: readonly Orderable[]): Fragment {
  return join(
    terms.map((term) => {
      if ("~ordering" in term) return term["~ordering"]();
      return isExpr(term) ? term["~expr"]() : columnIdentifier(table, term.name);
    }),
    fragment`, `,
  );
}

/** The outputs of a `select` or `returning` callback's result, in its key order. */
export function outputsOf(selection: Selection): Output[] {
  return Object.entries(selection).map(([alias, value]): Output => [
    alias,
    isExpr(value) ? value : value.name,
  ]);
}

/** Decodes the column outputs; an Expr's value runs no codec. */
export function decodeOutputs(table: Table, outputs: readonly Output[]): Decode | undefined {
  return decoderFor(
    table,
    outputs.flatMap(([alias, source]) => (typeof source === "string" ? [[alias, source]] : [])),
  );
}

/**
 * An output aliases its column back to the key the row type names, unless the two are one. An
 * enum or domain array is cast to text, which `decoderFor` reads: its OID differs per database, so
 * the driver can't be relied on to parse it (ADR-0023). An Expr always takes its alias.
 */
export function renderOutput(table: Table, [alias, key]: Output): Fragment {
  if (typeof key !== "string") return fragment`${key["~expr"]()} as ${identifier(alias)}`;
  const name = table.columnNames[key] ?? key;
  const column = table.columns[key];
  const cast = column !== undefined && isTextArray(column);
  if (!cast) {
    return alias === name
      ? identifier(name)
      : fragment`${identifier(name)} as ${identifier(alias)}`;
  }
  return fragment`${identifier(name)}::text as ${identifier(alias)}`;
}

/** Appends `returning` to the statement `body` builds, and decodes each row the picked columns return. */
export function returning<R, S extends Selection>(
  table: Table,
  pick: (columns: Refs<R>) => S,
  body: () => Fragment,
): Query<Selected<S>> {
  const outputs = outputsOf(pick(refsOf(table)));
  if (outputs.length === 0) throw new Error("returning needs at least one column");
  return withDecoder(
    brand<Query<Selected<S>>>({
      toSql() {
        const list = join(
          outputs.map((output) => renderOutput(table, output)),
          fragment`, `,
        );
        return fragment`${body()} returning ${list}`.toSql();
      },
    }),
    decodeOutputs(table, outputs),
  );
}
