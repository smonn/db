import type { SqlExpression } from "./index-expressions.ts";
import type { IndexMethod } from "./index-options.ts";

/** One key of an index: a column or expression, or one with its order and where NULLs sort. */
type IndexKeyEntry<K> =
  | K
  | {
      readonly key: K;
      /** Defaults to `"asc"`. */
      readonly order?: "asc" | "desc";
      /** Defaults to `"last"` for `"asc"` and `"first"` for `"desc"`, as in Postgres. */
      readonly nulls?: "first" | "last";
    };

type IndexKeys<K> = readonly [IndexKeyEntry<K>, ...IndexKeyEntry<K>[]];

type IndexShared<R> = {
  /** Columns stored in the index beyond its keys, so a query can read them without the table. */
  readonly include?: readonly R[];
  /** Defaults to `"btree"`. */
  readonly method?: IndexMethod;
  readonly unique?: boolean;
  /** Treats NULLs as equal in a unique index. */
  readonly nullsNotDistinct?: boolean;
  /** Indexes only the rows this `sql` expression holds for, such as `` sql`${t.deletedAt} is null` ``. */
  readonly where?: SqlExpression;
};

/**
 * An entry of the second callback's `indexes`, where `R` is a reference to one of the table's own
 * columns. A key is a reference, or an `sql` expression naming references, such as
 * `` sql`lower(${t.email})` ``; an entry with an expression key must give its own `name`.
 */
export type IndexEntry<R> =
  | (IndexShared<R> & {
      readonly columns: IndexKeys<R>;
      /** Replaces the derived name, `<table>_<columns joined by _>_idx`. */
      readonly name?: string;
    })
  | (IndexShared<R> & {
      readonly columns: IndexKeys<R | SqlExpression>;
      /** Postgres's default for an expression key, `<table>_expr_idx`, says nothing and collides. */
      readonly name: string;
    });
