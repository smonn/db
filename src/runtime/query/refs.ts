import type { Table } from "../definition/index.ts";
import { fragment, identifier, join, type Fragment } from "../sql/index.ts";
import { isTextArray } from "./array-text.ts";
import { decoderFor, encodeValue, withDecoder } from "./codecs.ts";
import { brand, type Query } from "./statement.ts";

/** A boolean SQL expression, built from column comparisons and the `and`, `or`, `not` exports. */
export type Predicate = { readonly "~predicate": () => Fragment };

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

/** One sort key for `orderBy`, made by `asc` or `desc`; a bare column sorts ascending. */
export type Ordering = { readonly "~ordering": () => Fragment };

type NullsOptions = { readonly nulls?: "first" | "last" };

/** A NOT NULL column has no NULLs to place, so its options type names `nulls` in the error. */
type Sortable<V> = null extends V
  ? {
      asc(options?: NullsOptions): Ordering;
      desc(options?: NullsOptions): Ordering;
    }
  : {
      asc(options?: { readonly "nulls needs a nullable column"?: never }): Ordering;
      desc(options?: { readonly "nulls needs a nullable column"?: never }): Ordering;
    };

export type ColumnRef<V> = SelectableColumn<V> &
  Sortable<V> &
  (null extends V ? NullChecks : unknown) & {
    eq(value: NonNullable<V>): Predicate;
    ne(value: NonNullable<V>): Predicate;
    gt(value: NonNullable<V>): Predicate;
    gte(value: NonNullable<V>): Predicate;
    lt(value: NonNullable<V>): Predicate;
    lte(value: NonNullable<V>): Predicate;
  };

/** Typed over the row, not its Table, so an error prints the row's keys. */
export type Refs<R> = {
  readonly [K in keyof R & string]: ColumnRef<R[K]>;
};

export type Selection = Record<string, SelectableColumn<unknown>>;

export type Selected<S extends Selection> = {
  -readonly [K in keyof S]: S[K] extends SelectableColumn<infer V> ? V : never;
};

export type Output = readonly [alias: string, column: string];

/** What `orderBy` takes: an ordering, or a bare column, which sorts ascending. */
export type Orderable = Ordering | SelectableColumn<unknown>;

/** Built when the statement renders, so a codec that throws rejects the query instead of the builder. */
const predicate = (piece: () => Fragment): Predicate => ({ "~predicate": piece });

function nullsOf(options: NullsOptions | undefined): Fragment {
  if (options === undefined) return fragment``;
  const unknown = Object.keys(options).filter((key) => key !== "nulls");
  if (unknown.length > 0) {
    throw new Error(`Unknown ordering option ${unknown.map((key) => `"${key}"`).join(", ")}`);
  }
  const { nulls } = options;
  if (nulls === undefined) return fragment``;
  if (nulls === "first") return fragment` nulls first`;
  if (nulls === "last") return fragment` nulls last`;
  throw new Error(`nulls must be "first" or "last", got ${JSON.stringify(nulls)}`);
}

function refOf(table: Table, name: string): ColumnRef<string | null> {
  const column = columnIdentifier(table, name);
  const order = (direction: Fragment, options: NullsOptions | undefined): Ordering => {
    const nulls = nullsOf(options);
    return {
      "~ordering": () => fragment`${identifier(table.name)}.${column} ${direction}${nulls}`,
    };
  };
  const compare = (operator: Fragment, value: unknown) =>
    predicate(() => fragment`${column} ${operator} ${encodeValue(table, name, value)}`);
  return {
    name,
    eq: (value) => compare(fragment`=`, value),
    ne: (value) => compare(fragment`<>`, value),
    gt: (value) => compare(fragment`>`, value),
    gte: (value) => compare(fragment`>=`, value),
    lt: (value) => compare(fragment`<`, value),
    lte: (value) => compare(fragment`<=`, value),
    asc: (options) => order(fragment`asc`, options),
    desc: (options) => order(fragment`desc`, options),
    isNull: () => predicate(() => fragment`${column} is null`),
    isNotNull: () => predicate(() => fragment`${column} is not null`),
  };
}

export function refsOf<R>(table: Table): Refs<R> {
  const refs = Object.fromEntries(
    Object.keys(table.columns).map((name) => [name, refOf(table, name)]),
  );
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Object.fromEntries loses the keys.
  return refs as unknown as Refs<R>;
}

function combine(separator: Fragment, terms: readonly Predicate[]): Predicate {
  return predicate(() => {
    const inner = join(
      terms.map((term) => term["~predicate"]()),
      separator,
    );
    return fragment`(${inner})`;
  });
}

export function and(first: Predicate, ...rest: Predicate[]): Predicate {
  return combine(fragment` and `, [first, ...rest]);
}

export function or(first: Predicate, ...rest: Predicate[]): Predicate {
  return combine(fragment` or `, [first, ...rest]);
}

export function not(term: Predicate): Predicate {
  return predicate(() => fragment`not (${term["~predicate"]()})`);
}

/** The column of key `key` as SQL names it, once `defineDatabase` mapped it. */
export function columnIdentifier(table: Table, key: string): Fragment {
  return identifier(table.columnNames[key] ?? key);
}

/** The `order by` list of `terms`, in the order given. */
export function renderOrderBy(table: Table, terms: readonly Orderable[]): Fragment {
  return join(
    terms.map((term) =>
      "~ordering" in term
        ? term["~ordering"]()
        : fragment`${identifier(table.name)}.${columnIdentifier(table, term.name)}`,
    ),
    fragment`, `,
  );
}

/**
 * An output aliases its column back to the key the row type names, unless the two are one. An
 * enum or domain array is cast to text, which `decoderFor` reads: its OID differs per database, so
 * the driver can't be relied on to parse it (ADR-0023).
 */
export function renderOutput(table: Table, [alias, key]: Output): Fragment {
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
  const picked = Object.entries(pick(refsOf(table)));
  if (picked.length === 0) throw new Error("returning needs at least one column");
  const named = picked.map(([alias, ref]): Output => [alias, ref.name]);
  const outputs = named.map((output) => renderOutput(table, output));
  return withDecoder(
    brand<Query<Selected<S>>>({
      toSql() {
        return fragment`${body()} returning ${join(outputs, fragment`, `)}`.toSql();
      },
    }),
    decoderFor(table, named),
  );
}
