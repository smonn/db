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
