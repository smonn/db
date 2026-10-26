import { isEnum, type Enum, type Table } from "../../runtime/definition/index.ts";
import { catalogBuilder, quoted, type Catalog, type CatalogBuilder } from "./catalog.ts";
import { columnType } from "./column-type.ts";
import { constraintNames, type ConstraintNames } from "./constraint-names.ts";
import { enumTypeNames, labelsOf } from "./enums.ts";

/** The shape `defineDatabase` returns, loosened so any Definition fits. */
export type DefinitionTables = {
  readonly [schema: string]: { readonly [name: string]: Table | Enum };
};

export function definitionCatalog(definition: DefinitionTables): Catalog {
  const builder = catalogBuilder();
  const enums = enumTypeNames(definition);
  for (const [schema, entries] of Object.entries(definition)) {
    builder.schema(schema);
    const tables: Record<string, Table> = {};
    for (const [name, entry] of Object.entries(entries)) {
      if (isEnum(entry)) builder.enumType(schema, name, { labels: labelsOf(schema, name, entry) });
      else tables[name] = entry;
    }
    const names = constraintNames(schema, tables);
    for (const [table, tableDefinition] of Object.entries(tables)) {
      addDefinitionTable(builder, { schema, table, names, enums }, tableDefinition);
    }
  }
  return builder.build();
}

type TableContext = {
  readonly schema: string;
  readonly table: string;
  readonly names: ConstraintNames;
  readonly enums: ReadonlyMap<Enum, string>;
};

function addDefinitionTable(
  builder: CatalogBuilder,
  { schema, table, names, enums }: TableContext,
  { columns, primaryKey, primaryKeyName, foreignKeys }: Table,
): void {
  builder.table(schema, table);
  const entries = Object.entries(columns);
  for (const [column, { state }] of entries) {
    builder.column(schema, table, column, {
      type: columnType(state, enums, quoted([schema, table, column])),
      notNull: state.notNull || primaryKey.includes(column) || state.identity !== undefined,
    });
    if (state.default !== undefined) {
      // introspect reads the real volatility from the Definition database.
      builder.columnDefault(schema, table, column, {
        expression: state.default,
        volatile: false,
      });
    }
    if (state.identity !== undefined) {
      builder.columnIdentity(schema, table, column, { generated: state.identity });
    }
  }
  if (primaryKey.length > 0) {
    builder.primaryKey(schema, table, names.primaryKey(table, primaryKey, primaryKeyName), {
      columns: [...primaryKey],
    });
  }
  for (const [column, { state }] of entries) {
    if (state.unique) {
      const name = names.unique(table, column, state.constraintName);
      builder.unique(schema, table, name, { column });
    }
  }
  for (const { name, columns: from, ...payload } of foreignKeys) {
    builder.foreignKey(schema, table, names.foreignKey(table, from, name), {
      columns: from,
      ...payload,
    });
  }
}
