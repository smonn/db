import type { Row, Table } from "../definition/index.ts";
import { identifier, join, sql, type Fragment, type RenderedSql } from "../sql/index.ts";

export type Statement = {
  toSql(): RenderedSql;
};

export type Query<R> = Statement & {
  /** Type-only: separates a statement that returns rows from one that only reports a count. */
  readonly "~returns"?: "rows";
  /** Type-only: the row each result holds. */
  readonly "~row"?: R;
};

export type ColumnRef<V> = {
  readonly name: string;
  /** Type-only: the value this column yields when selected. */
  readonly "~value"?: V;
};

export type Refs<T extends Table> = {
  readonly [K in keyof Row<T> & string]: ColumnRef<Row<T>[K]>;
};

export type Selection = Record<string, ColumnRef<unknown>>;

export type Selected<S extends Selection> = {
  -readonly [K in keyof S]: S[K] extends ColumnRef<infer V> ? V : never;
};

export type SelectQuery<T extends Table, R> = Query<R> & {
  /** The keys of the returned object name the output columns. */
  select<S extends Selection>(pick: (columns: Refs<T>) => S): SelectQuery<T, Selected<S>>;
};

type Output = readonly [alias: string, column: string];

export function refsOf<T extends Table>(table: T): Refs<T> {
  const refs = Object.fromEntries(Object.keys(table.columns).map((name) => [name, { name }]));
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Object.fromEntries loses the keys.
  return refs as Refs<T>;
}

export function renderOutput([alias, name]: Output): Fragment {
  return alias === name ? identifier(name) : sql`${identifier(name)} as ${identifier(alias)}`;
}

function selectQuery<T extends Table, R>(table: T, outputs: readonly Output[]): SelectQuery<T, R> {
  return {
    select(pick) {
      return selectQuery(
        table,
        Object.entries(pick(refsOf(table))).map(([alias, ref]) => [alias, ref.name]),
      );
    },
    toSql() {
      const columns = join(
        outputs.map((output) => renderOutput(output)),
        sql`, `,
      );
      return sql`select ${columns} from ${identifier(table.schema)}.${identifier(table.name)}`.toSql();
    },
  };
}

export function from<T extends Table>(table: T): SelectQuery<T, Row<T>> {
  return selectQuery(
    table,
    Object.keys(table.columns).map((name) => [name, name]),
  );
}
