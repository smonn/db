import { quoteIdentifier } from "../internal/index.ts";
import type { Columns } from "./column.ts";
import { isDomain, type Domain } from "./domain.ts";
import { isEnum, type Enum } from "./enum.ts";
import type { TableDefinition } from "./table.ts";

type Entry = TableDefinition | Enum | Domain;

type Schemas = Readonly<Record<string, Readonly<Record<string, Entry>>>>;

type ColumnNames = Readonly<Record<string, string>>;

/** The SQL name of each schema key, of each table, enum, and domain key under it, and of each table's column keys. */
export type SqlNames = {
  schema(key: string): string;
  entry(schema: string, key: string): string;
  columns(schema: string, table: string): ColumnNames;
};

const ENTRY_FIX =
  "give one of them another name with name in a table's second callback or a type's options";

/**
 * Throws for two keys that map to one SQL name, such as `userId` and `user_id` under snake_case:
 * `owner` names where they sit, and `fix` says how to rename one.
 */
function refuseClashes(named: ReadonlyMap<string, string>, owner: string, fix: string): void {
  const keys = new Map<string, string>();
  for (const [key, name] of named) {
    const other = keys.get(name);
    if (other !== undefined) {
      throw new Error(
        `${owner} "${other}" and "${key}" both map to the SQL name ${quoteIdentifier(name)}; ${fix}`,
      );
    }
    keys.set(name, key);
  }
}

type SchemaNames = {
  readonly entries: ReadonlyMap<string, string>;
  readonly columns: ReadonlyMap<string, ColumnNames>;
};

/** One schema's entry names and its tables' column names; `sqlSchema` names the schema in errors. */
function schemaNamesOf(
  entries: Readonly<Record<string, Entry>>,
  cased: (key: string) => string,
  sqlSchema: string,
): SchemaNames {
  const named = new Map(
    Object.entries(entries).map(([key, entry]) => [key, entry.explicitName ?? cased(key)]),
  );
  refuseClashes(named, `The keys of schema ${quoteIdentifier(sqlSchema)}`, ENTRY_FIX);
  const columns = new Map<string, ColumnNames>();
  for (const [key, entry] of Object.entries(entries)) {
    if (isEnum(entry) || isDomain(entry)) continue;
    const where = `${quoteIdentifier(sqlSchema)}.${quoteIdentifier(named.get(key) ?? key)}`;
    columns.set(key, columnNamesOf(entry.columns, cased, where));
  }
  return { entries: named, columns };
}

/**
 * Maps every schema, table, enum, domain, and column key with `cased`, unless the entry or column
 * gives its own name. Throws for two schemas, two entries of one schema, or two columns of one
 * table that take one name, since a table and a type share a schema's names.
 */
export function sqlNamesOf(schemas: Schemas, cased: (key: string) => string): SqlNames {
  const schemaNames = new Map(Object.keys(schemas).map((key) => [key, cased(key)]));
  refuseClashes(schemaNames, "The schema keys", "rename one of the schemas");
  const named = new Map<string, SchemaNames>();
  for (const [schema, entries] of Object.entries(schemas)) {
    named.set(schema, schemaNamesOf(entries, cased, schemaNames.get(schema) ?? schema));
  }
  return {
    schema: (key) => schemaNames.get(key) ?? key,
    entry: (schema, key) => named.get(schema)?.entries.get(key) ?? key,
    columns: (schema, table) => named.get(schema)?.columns.get(table) ?? {},
  };
}

/** Each column key's SQL name: its `.name()`, or the key mapped with `cased`. `table` names it in errors. */
function columnNamesOf(
  columns: Columns,
  cased: (key: string) => string,
  table: string,
): Record<string, string> {
  const named = new Map(
    Object.entries(columns).map(([key, { state }]) => [key, state.explicitName ?? cased(key)]),
  );
  refuseClashes(named, `The columns of ${table}`, "give one of them another name with .name()");
  return Object.fromEntries(named);
}
