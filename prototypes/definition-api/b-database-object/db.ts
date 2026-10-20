// PROTOTYPE, throwaway. Variant B stands in for `@smonn/db`: one database()
// call holds every schema and table, named by their keys. The CLI reads the
// Definition file's default export.

import { makeTable, type Columns, type Table, type TableOptions } from "../core.ts";

export * from "../core.ts";

export interface TableSpec<C extends Columns> {
  readonly kind: "table-spec";
  readonly columns: C;
  readonly options: TableOptions<C> | undefined;
}

export function table<C extends Columns>(columns: C, options?: TableOptions<NoInfer<C>>): TableSpec<C> {
  return { kind: "table-spec", columns, options };
}

type Schemas = Record<string, Record<string, TableSpec<any>>>;

export type Database<S extends Schemas> = {
  readonly [Schema in keyof S]: { readonly [Name in keyof S[Schema]]: Table<S[Schema][Name]["columns"]> };
};

export function database<S extends Schemas>(schemas: S): Database<S> {
  return Object.fromEntries(
    Object.entries(schemas).map(([schemaName, tables]) => [
      schemaName,
      Object.fromEntries(
        Object.entries(tables).map(([name, spec]) => [name, makeTable(schemaName, name, spec.columns, spec.options)]),
      ),
    ]),
  ) as Database<S>;
}

export function tablesOf(db: Database<Schemas>): Table[] {
  return Object.values(db).flatMap((tables) => Object.values(tables));
}
