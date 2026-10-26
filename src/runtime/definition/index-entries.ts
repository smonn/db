import type { IndexMethod } from "./index-options.ts";

/** One key of an index: a column, or a column with its order and where NULLs sort. */
type IndexKeyEntry<R> =
  | R
  | {
      readonly key: R;
      /** Defaults to `"asc"`. */
      readonly order?: "asc" | "desc";
      /** Defaults to `"last"` for `"asc"` and `"first"` for `"desc"`, as in Postgres. */
      readonly nulls?: "first" | "last";
    };

/** An entry of the second callback's `indexes`, where `R` is a reference to one of the table's own columns. */
export type IndexEntry<R> = {
  readonly columns: readonly [IndexKeyEntry<R>, ...IndexKeyEntry<R>[]];
  /** Columns stored in the index beyond its keys, so a query can read them without the table. */
  readonly include?: readonly R[];
  /** Defaults to `"btree"`. */
  readonly method?: IndexMethod;
  readonly unique?: boolean;
  /** Treats NULLs as equal in a unique index. */
  readonly nullsNotDistinct?: boolean;
  /** Replaces the derived name, `<table>_<columns joined by _>_idx`. */
  readonly name?: string;
};
