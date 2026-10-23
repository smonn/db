import { quoteIdentifier } from "../../runtime/internal/index.ts";

const MAX_NAME_BYTES = 63;

/**
 * Postgres's own default names (`users_pkey`, `users_email_key`), so a hand-written constraint
 * introspects to the same name. Postgres truncates a longer name, which would not key back.
 */
export function constraintName(table: string, suffix: string): string {
  const name = `${table}_${suffix}`;
  if (new TextEncoder().encode(name).length > MAX_NAME_BYTES) {
    throw new Error(
      `the constraint name ${quoteIdentifier(name)} is longer than ${MAX_NAME_BYTES} bytes`,
    );
  }
  return name;
}
