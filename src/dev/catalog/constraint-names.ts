import { quoteIdentifier } from "../../runtime/internal/index.ts";

const MAX_NAME_BYTES = 63;

export type ConstraintNames = {
  primaryKey(table: string, columns: readonly string[], name: string | undefined): string;
  unique(table: string, column: string, name: string | undefined): string;
};

/**
 * Names one schema's keys. A key without a name of its own takes Postgres's default
 * (`users_pkey`, `users_email_key`), so a hand-written constraint introspects to the same name.
 * Postgres truncates a longer name, which would not key back, and a key's index shares the
 * schema's relation names, so two keys can't take one name.
 */
export function constraintNames(schema: string): ConstraintNames {
  const owners = new Map<string, string>();
  const claim = (name: string, owner: string): string => {
    if (name === "") throw new Error(`${owner} has an empty constraint name`);
    if (new TextEncoder().encode(name).length > MAX_NAME_BYTES) {
      throw new Error(
        `the constraint name ${quoteIdentifier(name)} is longer than ${MAX_NAME_BYTES} bytes`,
      );
    }
    const other = owners.get(name);
    if (other !== undefined) {
      throw new Error(
        `${other} and ${owner} both take the constraint name ${quoteIdentifier(name)}; give one of them another name with primaryKey({ name }), unique({ name }), or { name, columns }`,
      );
    }
    owners.set(name, owner);
    return name;
  };
  const on = (table: string, columns: readonly string[]): string =>
    `${quoteIdentifier(schema)}.${quoteIdentifier(table)} (${columns.map((c) => quoteIdentifier(c)).join(", ")})`;
  return {
    primaryKey: (table, columns, name) =>
      claim(name ?? `${table}_pkey`, `the primary key on ${on(table, columns)}`),
    unique: (table, column, name) =>
      claim(name ?? `${table}_${column}_key`, `the unique constraint on ${on(table, [column])}`),
  };
}
