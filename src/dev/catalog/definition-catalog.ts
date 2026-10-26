import type { Table } from "../../runtime/definition/index.ts";
import { catalogBuilder, type Catalog, type CatalogBuilder } from "./catalog.ts";
import { constraintNames } from "./constraint-names.ts";

/** The shape `defineDatabase` returns, loosened so any Definition fits. */
export type DefinitionTables = {
  readonly [schema: string]: { readonly [table: string]: Table };
};

export function definitionCatalog(definition: DefinitionTables): Catalog {
  const builder = catalogBuilder();
  for (const [schema, tables] of Object.entries(definition)) {
    builder.schema(schema);
    const names = constraintNames(schema, tables);
    for (const [table, tableDefinition] of Object.entries(tables)) {
      addDefinitionTable(builder, names, { schema, table }, tableDefinition);
    }
  }
  return builder.build();
}

function addDefinitionTable(
  builder: CatalogBuilder,
  names: ReturnType<typeof constraintNames>,
  { schema, table }: { schema: string; table: string },
  { columns, primaryKey, primaryKeyName, foreignKeys }: Table,
): void {
  builder.table(schema, table);
  const entries = Object.entries(columns);
  for (const [column, { state }] of entries) {
    builder.column(schema, table, column, {
      type: postgresType(state.sqlType),
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

const TYPE_NAMES: Readonly<Record<string, string>> = {
  varchar: "character varying",
  timestamp: "timestamp without time zone",
  timestamptz: "timestamp with time zone",
};

/** Rewrites the Definition's `sqlType` the way `format_type` renders it, so both catalogs agree. */
function postgresType(sqlType: string): string {
  const [name = sqlType, modifiers = ""] = sqlType.split(/(?=\()/u);
  // Postgres reads `numeric(10)` back as `numeric(10,0)`.
  const spelled =
    name === "numeric" && /^\(\d+\)$/u.test(modifiers)
      ? `(${modifiers.slice(1, -1)},0)`
      : modifiers;
  return `${TYPE_NAMES[name] ?? name}${spelled}`;
}
