import type { Table } from "../definition/index.ts";
import type { RenderedSql } from "../sql/index.ts";

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

/** The type-only brands have no runtime value, so a statement is built from its parts and cast once. */
export function brand<Q extends Statement>(parts: Omit<Q, "~returns" | "~row" | "~many">): Q {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The brands exist only in types.
  return parts as Q;
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
