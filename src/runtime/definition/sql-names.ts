import { quoteIdentifier } from "../internal/index.ts";
import type { Columns } from "./column.ts";

type Schemas = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

/** The SQL name of each schema key, and of each table, enum, and domain key under it. */
export type SqlNames = {
  schema(key: string): string;
  entry(schema: string, key: string): string;
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

/** A table's, an enum's, or a domain's explicit name wins over casing. */
function givenName(entry: unknown): string | undefined {
  const name: unknown =
    typeof entry === "object" && entry !== null && "explicitName" in entry
      ? entry.explicitName
      : undefined;
  return typeof name === "string" ? name : undefined;
}

/**
 * Maps every schema, table, enum, and domain key with `cased`, unless the entry gives its own name.
 * Throws for two schemas, or two entries of one schema, that take one name, since a table and a
 * type share a schema's names.
 */
export function sqlNamesOf(schemas: Schemas, cased: (key: string) => string): SqlNames {
  const schemaNames = new Map(Object.keys(schemas).map((key) => [key, cased(key)]));
  refuseClashes(schemaNames, "The schema keys", "rename one of the schemas");
  const entryNames = new Map<string, ReadonlyMap<string, string>>();
  for (const [schema, entries] of Object.entries(schemas)) {
    const named = new Map(
      Object.entries(entries).map(([key, entry]) => [key, givenName(entry) ?? cased(key)]),
    );
    const owner = `The keys of schema ${quoteIdentifier(schemaNames.get(schema) ?? schema)}`;
    refuseClashes(named, owner, ENTRY_FIX);
    entryNames.set(schema, named);
  }
  return {
    schema: (key) => schemaNames.get(key) ?? key,
    entry: (schema, key) => entryNames.get(schema)?.get(key) ?? key,
  };
}

/** Each column key's SQL name: its `.name()`, or the key mapped with `cased`. `table` names it in errors. */
export function columnNamesOf(
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
