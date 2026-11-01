import type { Table } from "../definition/index.ts";
import { isFragment, type RenderedSql } from "../sql/index.ts";

export type Statement = {
  toSql(): RenderedSql;
};

export type Query<R> = Statement & {
  /** Type-only: separates a statement that returns rows from one that only reports a count. */
  readonly "~returns": "rows";
  /** Type-only: the row each result holds. */
  readonly "~row": R;
};

/** Marks a query that can change several rows, which `client.one` can't take. */
export type Many = { readonly "~many": true };

/**
 * What the builder and `sql` made, so `sql` can refuse one by identity rather than by shape: an
 * unfinished `deleteFrom` has a `toSql` that throws, and a Fragment one that isn't a statement.
 */
const made = new WeakMap<object, "a statement" | "an unfinished statement">();

/** The type-only brands have no runtime value, so a statement is built from its parts and cast once. */
export function brand<Q extends Statement>(parts: Omit<Q, "~returns" | "~row" | "~many">): Q {
  made.set(parts, "a statement");
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The brands exist only in types.
  return parts as Q;
}

/** Marks a builder that needs another call before it is a statement, such as `insert` before `values`. */
export function unfinished<B extends object>(builder: B): B {
  made.set(builder, "an unfinished statement");
  return builder;
}

/**
 * "a statement" or "an unfinished statement" for what `brand` or `unfinished` marked, and a third
 * kind for any other `toSql` but a Fragment, such as a statement a second copy of the package made.
 * `undefined` for a value.
 */
export function statementKind(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const kind = made.get(value);
  if (kind !== undefined) return kind;
  return "toSql" in value && !isFragment(value)
    ? "a statement this copy of the package did not make"
    : undefined;
}

/**
 * Throws for a table `defineDatabase` never named. TypeScript rejects one, so only plain-JS callers
 * reach it, and rendering would otherwise fail with a TypeError that names none of this.
 */
export function assertRegistered(table: Table): void {
  // `defineDatabase` sets the SQL names together, so a missing schema stands for all of them.
  const schema: Table["schema"] | undefined = table.schema;
  if (schema === undefined) {
    throw new Error(
      "The table lacks SQL names; take it from the object defineDatabase returned, not from defineTable",
    );
  }
}
