import type { Row, Table } from "../definition/index.ts";
import { identifier, join, sql, type Fragment } from "../sql/index.ts";
import {
  refsOf,
  renderOutput,
  type Query,
  type Refs,
  type Selected,
  type Selection,
  type Statement,
} from "./from.ts";

type NullableKeys<R> = { [K in keyof R]: null extends R[K] ? K : never }[keyof R];

/** NOT NULL columns are required; nullable columns may be left out. */
export type NewRow<T extends Table> = {
  [K in Exclude<keyof Row<T>, NullableKeys<Row<T>>>]: Row<T>[K];
} & {
  [K in NullableKeys<Row<T>>]?: Row<T>[K];
};

export type InsertStatement<T extends Table> = Statement & {
  /** Type-only: a plain insert reports a count, so only `client.run` takes it. */
  readonly "~returns"?: "count";
  /** The keys of the returned object name the output columns. */
  returning<S extends Selection>(pick: (columns: Refs<T>) => S): Query<Selected<S>>;
};

/** A column no row gives a value for is left out; a row that skips a column gets its default. */
function insertInto(table: Table, rows: readonly Record<string, unknown>[]): Fragment {
  const target = sql`insert into ${identifier(table.schema)}.${identifier(table.name)}`;
  const names = Object.keys(table.columns).filter((name) =>
    rows.some((row) => row[name] !== undefined),
  );
  if (names.length === 0) {
    if (rows.length > 1) throw new Error("insert needs a value in at least one column");
    return sql`${target} default values`;
  }
  const tuples = rows.map((row) => {
    const cells = names.map((name) => (row[name] === undefined ? sql`default` : sql`${row[name]}`));
    return sql`(${join(cells, sql`, `)})`;
  });
  const columns = join(
    names.map((name) => identifier(name)),
    sql`, `,
  );
  return sql`${target} (${columns}) values ${join(tuples, sql`, `)}`;
}

function insertStatement<T extends Table>(
  table: T,
  rows: readonly Record<string, unknown>[],
): InsertStatement<T> {
  return {
    returning<S extends Selection>(pick: (columns: Refs<T>) => S): Query<Selected<S>> {
      const outputs = Object.entries(pick(refsOf(table))).map(([alias, ref]) =>
        renderOutput([alias, ref.name]),
      );
      return {
        toSql() {
          return sql`${insertInto(table, rows)} returning ${join(outputs, sql`, `)}`.toSql();
        },
      };
    },
    toSql() {
      return insertInto(table, rows).toSql();
    },
  };
}

export function insert<T extends Table>(
  table: T,
): {
  values(rows: NewRow<T> | readonly NewRow<T>[]): InsertStatement<T>;
} {
  return {
    values(rows) {
      const list: readonly Record<string, unknown>[] = Array.isArray(rows) ? rows : [rows];
      if (list.length === 0) throw new Error("insert needs at least one row");
      return insertStatement(table, list);
    },
  };
}
