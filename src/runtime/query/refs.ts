import type { ScalarClass, SqlClass, Table } from "../definition/index.ts";
import { fragment, identifier, join, type Fragment } from "../sql/index.ts";
import { encodeElement, encodeList, encodeValue } from "./codecs.ts";
import { assertComparable, type ComparedColumn } from "./comparable.ts";
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
 * A column as the other side of a comparison: any column of the same SQL type class, nullable or
 * not, whatever its TypeScript type, since Postgres compares `integer` with `bigint` but not `uuid`
 * with `text`.
 */
type ColumnOperand<S extends SqlClass> = { readonly "~class": S };

/**
 * `S` is the column's SQL type class. Each test wraps it in a tuple, so a union such as the
 * default offers a call only when every member does. A comparison takes a value, which binds
 * through the column's codec, or a column, which runs none.
 */
export type ColumnRef<V, S extends SqlClass = SqlClass> = SelectableColumn<V> &
  Sortable<V> &
  (null extends V ? NullChecks : unknown) &
  ([S] extends [ScalarClass] ? SetMatches<V> : unknown) &
  ([S] extends [`${string}[]`] ? ArrayMatches<V> : unknown) &
  ([S] extends ["text"] ? PatternMatches : unknown) & {
    /** Type-only: the column's SQL type class, which a column operand shares. */
    readonly "~class": S;
    eq(operand: NonNullable<V> | ColumnOperand<S>): Predicate;
    ne(operand: NonNullable<V> | ColumnOperand<S>): Predicate;
    gt(operand: NonNullable<V> | ColumnOperand<S>): Predicate;
    gte(operand: NonNullable<V> | ColumnOperand<S>): Predicate;
    lt(operand: NonNullable<V> | ColumnOperand<S>): Predicate;
    lte(operand: NonNullable<V> | ColumnOperand<S>): Predicate;
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

/**
 * The column a ref reads: key `key` of `table`, which a joined query qualifies by `alias`, and an
 * upsert's existing row by `schema` too, so a table named `excluded` can't pass for that row.
 */
export type ColumnSource = {
  readonly table: Table;
  readonly key: string;
  readonly alias: string;
  readonly schema?: string | undefined;
};

/** What `orderBy` takes: an ordering, or a bare column or Expr, which sorts ascending. */
export type Orderable = Ordering | SelectableColumn<unknown> | Expr;

const predicate: (render: () => Fragment) => Predicate = expr;

type RefEntry = { readonly source: ColumnSource; readonly compared: ComparedColumn };

/** The column each ref reads, so a template, `select`, `orderBy`, and `eq` can tell a ref from a value. */
const refEntries = new WeakMap<object, RefEntry>();

/**
 * What every ref carries at run time; `Refs` hides the calls a column's class can't take, and
 * `~class` exists only in types.
 */
type AnyRef = Omit<ColumnRef<string | null, "text">, "~class"> & {
  includes(value: string): Predicate;
};

/** Whether refs render qualified by their table's alias, as they do while a joined query renders. */
let qualifying = false;

/**
 * Runs `render` with every ref qualified by its alias when `qualified`. A ref renders when its
 * statement does, so a `where` written before a join still renders qualified once joined.
 */
export function renderQualified<T>(qualified: boolean, render: () => T): T {
  const outer = qualifying;
  qualifying = qualified;
  try {
    return render();
  } finally {
    qualifying = outer;
  }
}

/** Always qualified: in `order by`, a bare name means an output alias of that name first. */
export function qualifiedColumn({ table, key, alias, schema }: ColumnSource): Fragment {
  const qualified = fragment`${identifier(alias)}.${columnIdentifier(table, key)}`;
  return schema === undefined ? qualified : fragment`${identifier(schema)}.${qualified}`;
}

export function columnSql(source: ColumnSource): Fragment {
  return qualifying ? qualifiedColumn(source) : columnIdentifier(source.table, source.key);
}

function entryOf(value: unknown): RefEntry | undefined {
  return typeof value === "object" && value !== null ? refEntries.get(value) : undefined;
}

function refOf(source: ColumnSource, definition: Column): AnyRef {
  const { table, key: name, alias } = source;
  const column = () => columnSql(source);
  const compared = {
    alias,
    column: table.columnNames[name] ?? name,
    state: definition.state,
  };
  const compare = (operator: Fragment, operand: unknown) => {
    const other = entryOf(operand);
    if (other === undefined) {
      return predicate(
        () => fragment`${column()} ${operator} ${encodeValue(table, name, operand)}`,
      );
    }
    assertComparable(compared, other.compared);
    return predicate(() => fragment`${column()} ${operator} ${columnSql(other.source)}`);
  };
  const ref: AnyRef = {
    name,
    eq: (value) => compare(fragment`=`, value),
    ne: (value) => compare(fragment`<>`, value),
    gt: (value) => compare(fragment`>`, value),
    gte: (value) => compare(fragment`>=`, value),
    lt: (value) => compare(fragment`<`, value),
    lte: (value) => compare(fragment`<=`, value),
    in: (values) =>
      predicate(() => fragment`${column()} = any(${encodeList(table, name, definition, values)})`),
    notIn: (values) =>
      predicate(() => fragment`${column()} <> all(${encodeList(table, name, definition, values)})`),
    includes: (value) =>
      predicate(() => fragment`${encodeElement(table, name, value)} = any(${column()})`),
    like: (pattern) => predicate(() => fragment`${column()} like ${pattern}`),
    ilike: (pattern) => predicate(() => fragment`${column()} ilike ${pattern}`),
    ...sortable(() => qualifiedColumn(source)),
    isNull: () => predicate(() => fragment`${column()} is null`),
    isNotNull: () => predicate(() => fragment`${column()} is not null`),
  };
  refEntries.set(ref, { source, compared });
  return ref;
}

/**
 * Throws when Postgres can't compare the columns refs `left` and `right` read; a value that is no
 * ref passes. `doUpdate` holds an assignment to this too, which is stricter than Postgres: it
 * assigns some pairs it won't compare, such as `text[]` and `varchar[]`.
 */
export function assertComparableRefs(left: unknown, right: unknown): void {
  const [first, second] = [entryOf(left), entryOf(right)];
  if (first !== undefined && second !== undefined) {
    assertComparable(first.compared, second.compared);
  }
}

/** The column `value` reads; `undefined` for a value that is no ref. */
export function sourceOf(value: unknown): ColumnSource | undefined {
  return entryOf(value)?.source;
}

/** The SQL a ref renders inside a template, the same its comparisons render; `undefined` for a value that is no ref. */
export function refSql(value: unknown): Fragment | undefined {
  const source = sourceOf(value);
  return source === undefined ? undefined : columnSql(source);
}

/** `schema` qualifies each ref by schema too, as an upsert's existing row needs. */
export function refsOf<R, C extends Classes<R> = Classes<R>>(
  table: Table,
  alias: string = table.name,
  schema?: string,
): Refs<R, C> {
  const refs = Object.fromEntries(
    Object.entries(table.columns).map(([key, definition]) => [
      key,
      refOf({ table, key, alias, schema }, definition),
    ]),
  );
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Object.fromEntries loses the keys.
  return refs as unknown as Refs<R, C>;
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
