import type { Table } from "../../runtime/definition/index.ts";
import { quoteIdentifier } from "../../runtime/internal/index.ts";

const MAX_NAME_BYTES = 63;

export type ConstraintNames = {
  primaryKey(table: string, columns: readonly string[], name: string | undefined): string;
  unique(table: string, columns: readonly string[], name: string | undefined): string;
  foreignKey(table: string, columns: readonly string[], name: string | undefined): string;
};

/**
 * Postgres's default name, `<table>_<columns joined by _>_<suffix>` (`key`, `fkey`, `idx`), which
 * `validate` refuses when it runs past 63 bytes, where Postgres would truncate it.
 */
function derivedName(table: string, columns: readonly string[], suffix: string): string {
  return `${table}_${columns.join("_")}_${suffix}`;
}

/** Describes each relation a key's name can clash with: the tables and the identity sequences. */
function relationOwners(
  schema: string,
  tables: Readonly<Record<string, Table>>,
): Map<string, string> {
  const relations = new Map<string, string>();
  for (const table of Object.keys(tables)) {
    relations.set(table, `the table ${quoteIdentifier(schema)}.${quoteIdentifier(table)}`);
  }
  for (const [table, { columns }] of Object.entries(tables)) {
    for (const [column, { state }] of Object.entries(columns)) {
      const sequence = `${table}_${column}_seq`;
      // Postgres names the sequence around a table of that name.
      if (state.identity === undefined || relations.has(sequence)) continue;
      relations.set(
        sequence,
        `the identity sequence of ${quoteIdentifier(schema)}.${quoteIdentifier(table)} (${quoteIdentifier(column)})`,
      );
    }
  }
  return relations;
}

function validate(name: string, owner: string): void {
  if (name === "") throw new Error(`${owner} has an empty constraint name`);
  if (new TextEncoder().encode(name).length > MAX_NAME_BYTES) {
    throw new Error(
      `the constraint name ${quoteIdentifier(name)} is longer than ${MAX_NAME_BYTES} bytes`,
    );
  }
}

/**
 * Remembers which constraint of a table took a name. A foreign key owns no index, so its name
 * clashes only with another constraint on its table.
 */
function onTableClaims(): (table: string, name: string, owner: string) => string {
  const onTable = new Map<string, Map<string, string>>();
  return (table, name, owner) => {
    const names = onTable.get(table) ?? new Map<string, string>();
    const other = names.get(name);
    if (other !== undefined) {
      throw new Error(
        `${other} and ${owner} both take the constraint name ${quoteIdentifier(name)}; give one of them another name with primaryKey({ name }), unique({ name }), references(target, { name }), or { name, columns }`,
      );
    }
    names.set(name, owner);
    onTable.set(table, names);
    return name;
  };
}

/**
 * Names one schema's keys. A key without a name of its own takes Postgres's default
 * (`users_pkey`, `users_email_key`), so a hand-written constraint introspects to the same name.
 * Postgres truncates a longer name, which would not key back, and a key's index shares the
 * schema's relation names, so a key can't take the name of another key, a table, or the sequence
 * Postgres derives for an identity column (`<table>_<column>_seq`). A foreign key derives
 * `<table>_<columns joined by _>_fkey` and owns no index, so it clashes only with another
 * constraint on its table.
 */
export function constraintNames(
  schema: string,
  tables: Readonly<Record<string, Table>>,
): ConstraintNames {
  const relations = relationOwners(schema, tables);
  const owners = new Map<string, string>();
  const claimOnTable = onTableClaims();
  const claim = (table: string, name: string, owner: string): string => {
    validate(name, owner);
    const relation = relations.get(name);
    if (relation !== undefined) {
      throw new Error(
        `${owner} takes the constraint name ${quoteIdentifier(name)}, which is also the name of ${relation}; give the key another name with primaryKey({ name }), unique({ name }), or { name, columns }`,
      );
    }
    const other = owners.get(name);
    if (other !== undefined) {
      throw new Error(
        `${other} and ${owner} both take the constraint name ${quoteIdentifier(name)}; give one of them another name with primaryKey({ name }), unique({ name }), or { name, columns }`,
      );
    }
    owners.set(name, owner);
    return claimOnTable(table, name, owner);
  };
  const on = (table: string, columns: readonly string[]): string =>
    `${quoteIdentifier(schema)}.${quoteIdentifier(table)} (${columns.map((c) => quoteIdentifier(c)).join(", ")})`;
  return {
    primaryKey: (table, columns, name) =>
      claim(table, name ?? `${table}_pkey`, `the primary key on ${on(table, columns)}`),
    unique: (table, columns, name) =>
      claim(
        table,
        name ?? derivedName(table, columns, "key"),
        `the unique constraint on ${on(table, columns)}`,
      ),
    foreignKey: (table, columns, name) => {
      const taken = name ?? derivedName(table, columns, "fkey");
      const owner = `the foreign key on ${on(table, columns)}`;
      validate(taken, owner);
      return claimOnTable(table, taken, owner);
    },
  };
}
