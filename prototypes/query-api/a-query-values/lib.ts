// PROTOTYPE, throwaway. Variant A: `from` and `insert` build plain statement
// values with no database attached; a client runs them.

import type { AnyTable, NewRow, Row, Simplify, Table } from "../definition.ts";
import {
  makeInsert,
  makeSelect,
  selectState,
  toRows,
  type Driver,
  type Ops,
  type Predicate,
  type Refs,
  type Selected,
  type Selection,
  type Statement,
} from "../query.ts";

type ColumnName<T extends AnyTable> = keyof T["columns"] & string;

export interface Query<R> {
  readonly "~rows": R;
  toSql(): Statement;
}

export interface SelectQuery<T extends AnyTable, R> extends Query<R> {
  where(filter: (columns: Refs<T>, ops: Ops) => Predicate): SelectQuery<T, R>;
  select<S extends Selection>(pick: (columns: Refs<T>) => S): SelectQuery<T, Selected<S>>;
  select<K extends ColumnName<T>>(...columns: [K, ...K[]]): SelectQuery<T, Simplify<Pick<Row<T>, K>>>;
}

export interface InsertStatement<T extends AnyTable> {
  returning<S extends Selection>(pick: (columns: Refs<T>) => S): Query<Selected<S>>;
  returning<K extends ColumnName<T>>(...columns: [K, ...K[]]): Query<Simplify<Pick<Row<T>, K>>>;
  toSql(): Statement;
}

export function from<T extends Table<any, any>>(table: T): SelectQuery<T, Row<T>> {
  return makeSelect(selectState(table), undefined) as SelectQuery<T, Row<T>>;
}

export function insert<T extends Table<any, any>>(table: T) {
  return {
    values: (rows: NewRow<T> | readonly NewRow<T>[]): InsertStatement<T> =>
      makeInsert({ table, rows: toRows(rows), returning: undefined }, undefined) as InsertStatement<T>,
  };
}

export function createClient(driver: Driver) {
  return {
    all: async <R>(query: Query<R>): Promise<R[]> => (await driver.query(query.toSql())).rows as R[],
    one: async <R>(query: Query<R>): Promise<R> => {
      const { rows } = await driver.query(query.toSql());
      if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`);
      return rows[0] as R;
    },
    run: async (statement: { toSql(): Statement }): Promise<{ count: number }> => ({
      count: (await driver.query(statement.toSql())).count,
    }),
  };
}
