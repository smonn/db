/* oxlint-disable -- throwaway prototype on a branch that is never merged */
// PROTOTYPE, throwaway. Variant A: a foreign key goes on its column with `.references()`.
import {
  type ColumnState,
  type Columns,
  columnForeignKeys,
  type ForeignKeyOptions,
  of,
  primaryKeyOf,
  resolve,
  type TableDefinition,
  type Target,
  type Types,
} from "../core.ts";

export type Column<V, N extends boolean = false, Key extends boolean = false> = {
  readonly state: ColumnState;
  readonly "~types": Types<V, N, Key>;
  notNull(): Column<V, true, Key>;
  primaryKey(): Column<V, true, true>;
  unique(): Column<V, N, true>;
  /** A foreign key on this column alone, to a key column of another table holding the same type. */
  references(target: () => Target<V>, options?: ForeignKeyOptions): Column<V, N, Key>;
};

export type Factories = {
  readonly integer: () => Column<number>;
  readonly bigint: () => Column<bigint>;
  readonly uuid: () => Column<string>;
  readonly text: () => Column<string>;
};

export const factories = {
  integer: () => of("integer"),
  bigint: () => of("bigint"),
  uuid: () => of("uuid"),
  text: () => of("text"),
} as Factories;

export function defineTable<C extends Columns>(define: (c: Factories) => C): TableDefinition<C> {
  const columns = define(factories);
  return {
    columns,
    primaryKey: primaryKeyOf(columns, []),
    foreignKeys: columnForeignKeys(columns),
  };
}

export function defineDatabase<S extends Record<string, Record<string, TableDefinition>>>(
  schemas: S,
) {
  return { schemas, foreignKeys: resolve(schemas) };
}
