import { quoteIdentifier } from "../internal/index.ts";
import { isDomain, type Domain } from "./domain.ts";
import { isEnum, type Enum } from "./enum.ts";
import { renamedExpression } from "./index-expressions.ts";
import type { TableIndex } from "./indexes.ts";
import type { SqlNames } from "./sql-names.ts";
import type { Table } from "./table.ts";

/**
 * A Definition keyed by SQL names all the way down, which generate reads: schemas, entries, and
 * each table's columns, keys, indexes, and foreign keys. Enums and domains stay the values their
 * columns hold, since the catalog finds their names by identity.
 */
export type SqlDefinition = {
  readonly [schema: string]: { readonly [name: string]: Table | Enum | Domain };
};

/**
 * `Symbol.for`, so a Definition loaded through another copy of the package still finds it, and
 * called late, since the package runs no code at import.
 */
function viewKey(): symbol {
  return Symbol.for("@smonn/db.sqlDefinition");
}

/** Builds `database`'s SQL view and keeps it on the Database, out of sight of its keys. */
export function withSqlDefinition<D extends SqlDefinition>(database: D, names: SqlNames): D {
  const view = Object.fromEntries(
    Object.entries(database).map(([schema, entries]) => [
      names.schema(schema),
      Object.fromEntries(
        Object.entries(entries).map(([key, entry]) => [
          names.entry(schema, key),
          isEnum(entry) || isDomain(entry) ? entry : viewTable(entry),
        ]),
      ),
    ]),
  );
  Object.defineProperty(database, viewKey(), { value: view });
  return database;
}

/**
 * The SQL view `defineDatabase` kept on `definition`, or `definition` itself without one, which
 * then must already be keyed by SQL names: a copy such as `{ ...db }` loses the view.
 */
export function sqlDefinition(definition: SqlDefinition): SqlDefinition {
  const view: unknown = Reflect.get(definition, viewKey());
  if (isView(view)) return view;
  for (const [schema, entries] of Object.entries(definition)) {
    const keyed = Object.entries(entries).find(([key, entry]) => !namedByKeys(schema, key, entry));
    if (keyed === undefined) continue;
    throw new Error(
      `The Definition names ${quoteIdentifier(schema)}.${quoteIdentifier(keyed[0])} by its keys, though defineDatabase mapped it to SQL names; pass the object defineDatabase returned, not a copy such as { ...db }`,
    );
  }
  return definition;
}

/** Whether every SQL name of `entry` is the key it sits under. */
function namedByKeys(schema: string, key: string, entry: Table | Enum | Domain): boolean {
  if (isEnum(entry) || isDomain(entry)) {
    return entry.explicitName === undefined || entry.explicitName === key;
  }
  const columns = Object.entries(entry.columnNames);
  return entry.schema === schema && entry.name === key && columns.every(([k, n]) => k === n);
}

/** Only `withSqlDefinition` writes the property, so an object there is the view. */
function isView(value: unknown): value is SqlDefinition {
  return typeof value === "object" && value !== null;
}

function viewTable(table: Table): Table {
  const column = (key: string): string => table.columnNames[key] ?? key;
  const names = Object.values(table.columnNames);
  return {
    ...table,
    columns: Object.fromEntries(Object.entries(table.columns).map(([k, c]) => [column(k), c])),
    columnNames: Object.fromEntries(names.map((name) => [name, name])),
    primaryKey: table.primaryKey.map(column),
    uniques: table.uniques.map((unique) => ({ ...unique, columns: unique.columns.map(column) })),
    declaredForeignKeys: table.declaredForeignKeys.map((declared) => ({
      ...declared,
      columns: declared.columns.map(column),
      references:
        typeof declared.references === "function"
          ? declared.references
          : declared.references.map(column),
    })),
    indexes: table.indexes.map((index) => viewIndex(index, column)),
    foreignKeys: table.foreignKeys.map((key) => ({ ...key, columns: key.columns.map(column) })),
  };
}

function viewIndex(index: TableIndex, column: (key: string) => string): TableIndex {
  return {
    ...index,
    keys: index.keys.map((key) =>
      "column" in key
        ? { ...key, column: column(key.column) }
        : { ...key, expression: renamedExpression(key, column) ?? key.expression },
    ),
    include: index.include.map(column),
    where:
      index.where === undefined ? undefined : (renamedExpression(index, column) ?? index.where),
  };
}
