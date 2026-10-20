// PROTOTYPE, throwaway. Variant B: a client bound to a Driver hands out
// builders you await directly, as in Drizzle and Kysely.

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

export interface Returning<R> extends PromiseLike<R[]> {
  one(): Promise<R>;
  toSql(): Statement;
}

export interface SelectQuery<T extends AnyTable, R> extends Returning<R> {
  where(filter: (columns: Refs<T>, ops: Ops) => Predicate): SelectQuery<T, R>;
  select<S extends Selection>(pick: (columns: Refs<T>) => S): SelectQuery<T, Selected<S>>;
  select<K extends ColumnName<T>>(...columns: [K, ...K[]]): SelectQuery<T, Simplify<Pick<Row<T>, K>>>;
}

export interface InsertStatement<T extends AnyTable> extends PromiseLike<{ count: number }> {
  returning<S extends Selection>(pick: (columns: Refs<T>) => S): Returning<Selected<S>>;
  returning<K extends ColumnName<T>>(...columns: [K, ...K[]]): Returning<Simplify<Pick<Row<T>, K>>>;
  toSql(): Statement;
}

export function connect(driver: Driver) {
  return {
    from: <T extends Table<any, any>>(table: T): SelectQuery<T, Row<T>> =>
      makeSelect(selectState(table), driver) as SelectQuery<T, Row<T>>,
    insert: <T extends Table<any, any>>(table: T) => ({
      values: (rows: NewRow<T> | readonly NewRow<T>[]): InsertStatement<T> =>
        makeInsert({ table, rows: toRows(rows), returning: undefined }, driver) as InsertStatement<T>,
    }),
  };
}
