/* oxlint-disable -- throwaway prototype on a branch that is never merged */
// PROTOTYPE, throwaway. Variant C: a single-column foreign key goes on its column, as `.primaryKey()`
// does, and a composite or self reference goes in the second callback, as a composite primary key does.
import { type Factories, factories } from "../a-column/lib.ts";
import { type Checked, type Extras, type Refs, tableParts } from "../b-table/lib.ts";
import {
  type Columns,
  columnForeignKeys,
  refsOf,
  resolve,
  type RuntimeRef,
  type TableDefinition,
} from "../core.ts";

export function defineTable<C extends Columns, const X extends Extras<C>>(
  define: (c: Factories) => C,
  extras?: (t: Refs<C>) => X & Checked<C, X>,
): TableDefinition<C> {
  const columns = define(factories);
  const own: Record<string, RuntimeRef> = refsOf(columns);
  const declared = extras?.(own as unknown as Refs<C>) as Extras<Columns> | undefined;
  const parts = tableParts(columns, own, declared);
  return {
    columns,
    primaryKey: parts.primaryKey,
    foreignKeys: [...columnForeignKeys(columns), ...parts.foreignKeys],
  };
}

export function defineDatabase<S extends Record<string, Record<string, TableDefinition>>>(
  schemas: S,
) {
  return { schemas, foreignKeys: resolve(schemas) };
}
