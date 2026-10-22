import type { Row, Table } from "../definition/index.ts";
import { identifier, join, sql, type Fragment, type RenderedSql } from "../sql/index.ts";

export type Statement = {
  toSql(): RenderedSql;
};

export type Query<R> = Statement & {
  /** Type-only: separates a statement that returns rows from one that only reports a count. */
  readonly "~returns": "rows";
  /** Type-only: the row each result holds. */
  readonly "~row": R;
};

/** The type-only brands have no runtime value, so a statement is built from its parts and cast once. */
export function brand<Q extends Statement>(parts: Omit<Q, "~returns" | "~row" | "~many">): Q {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The brands exist only in types.
  return parts as Q;
}

/** A boolean SQL expression, built from column comparisons and `where`'s `and`, `or`, `not`. */
export type Predicate = { readonly "~predicate": Fragment };

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

export type ColumnRef<V> = SelectableColumn<V> &
  (null extends V ? NullChecks : unknown) & {
    eq(value: NonNullable<V>): Predicate;
    ne(value: NonNullable<V>): Predicate;
    gt(value: NonNullable<V>): Predicate;
    gte(value: NonNullable<V>): Predicate;
    lt(value: NonNullable<V>): Predicate;
    lte(value: NonNullable<V>): Predicate;
  };

export type Refs<T extends Table> = {
  readonly [K in keyof Row<T> & string]: ColumnRef<Row<T>[K]>;
};

export type Selection = Record<string, SelectableColumn<unknown>>;

export type Selected<S extends Selection> = {
  -readonly [K in keyof S]: S[K] extends SelectableColumn<infer V> ? V : never;
};

export type SelectQuery<T extends Table, R> = Query<R> & {
  /** The keys of the returned object name the output columns. */
  select<S extends Selection>(pick: (columns: Refs<T>) => S): SelectQuery<T, Selected<S>>;
  /** Combines with any earlier `where` using `and`. */
  where(pick: (columns: Refs<T>) => Predicate): SelectQuery<T, R>;
};

type Output = readonly [alias: string, column: string];

type State = {
  readonly outputs: readonly Output[];
  readonly predicate?: Predicate;
};

const predicate = (fragment: Fragment): Predicate => ({ "~predicate": fragment });

function refOf(name: string): ColumnRef<string | null> {
  const column = identifier(name);
  return {
    name,
    eq: (value) => predicate(sql`${column} = ${value}`),
    ne: (value) => predicate(sql`${column} <> ${value}`),
    gt: (value) => predicate(sql`${column} > ${value}`),
    gte: (value) => predicate(sql`${column} >= ${value}`),
    lt: (value) => predicate(sql`${column} < ${value}`),
    lte: (value) => predicate(sql`${column} <= ${value}`),
    isNull: () => predicate(sql`${column} is null`),
    isNotNull: () => predicate(sql`${column} is not null`),
  };
}

export function refsOf<T extends Table>(table: T): Refs<T> {
  const refs = Object.fromEntries(Object.keys(table.columns).map((name) => [name, refOf(name)]));
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Object.fromEntries loses the keys.
  return refs as unknown as Refs<T>;
}

function combine(separator: Fragment, terms: readonly Predicate[]): Predicate {
  const inner = join(
    terms.map((term) => term["~predicate"]),
    separator,
  );
  return predicate(sql`(${inner})`);
}

export function and(first: Predicate, ...rest: Predicate[]): Predicate {
  return combine(sql` and `, [first, ...rest]);
}

export function or(first: Predicate, ...rest: Predicate[]): Predicate {
  return combine(sql` or `, [first, ...rest]);
}

export function not(term: Predicate): Predicate {
  return predicate(sql`not (${term["~predicate"]})`);
}

export function renderOutput([alias, name]: Output): Fragment {
  return alias === name ? identifier(name) : sql`${identifier(name)} as ${identifier(alias)}`;
}

function selectQuery<T extends Table, R>(table: T, state: State): SelectQuery<T, R> {
  return brand<SelectQuery<T, R>>({
    select(pick) {
      const outputs = Object.entries(pick(refsOf(table))).map(([alias, ref]): Output => [
        alias,
        ref.name,
      ]);
      return selectQuery(table, { ...state, outputs });
    },
    where(pick) {
      const next = pick(refsOf(table));
      return selectQuery(table, {
        ...state,
        predicate: state.predicate ? and(state.predicate, next) : next,
      });
    },
    toSql() {
      const columns = join(
        state.outputs.map((output) => renderOutput(output)),
        sql`, `,
      );
      const filter = state.predicate ? sql` where ${state.predicate["~predicate"]}` : sql``;
      return sql`select ${columns} from ${identifier(table.schema)}.${identifier(table.name)}${filter}`.toSql();
    },
  });
}

export function from<T extends Table>(table: T): SelectQuery<T, Row<T>> {
  return selectQuery(table, {
    outputs: Object.keys(table.columns).map((name): Output => [name, name]),
  });
}
