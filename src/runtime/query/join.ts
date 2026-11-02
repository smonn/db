import type { Row, SqlClass, Table } from "../definition/index.ts";
import type { Expr } from "./expr.ts";
import type { Orderable, Refs, Selected, Selection } from "./refs.ts";
import type { Query } from "./statement.ts";

/**
 * The joins a select takes before `select`. `J` holds each table's refs, in join order. Each
 * joined table's refs are written out, since a named alias in the tuple would print the Table.
 */
export type Joins<J extends readonly unknown[]> = {
  /** `on` gets each table's columns in join order, the joined one last. */
  innerJoin<T extends Table>(
    table: T,
    on: (
      ...refs: [
        ...J,
        Refs<
          { [K in keyof Row<T>]: Row<T>[K] },
          {
            [K in keyof Row<T>]: T["columns"][K] extends {
              readonly "~types": { readonly sqlClass: infer S extends SqlClass };
            }
              ? S
              : never;
          }
        >,
      ]
    ) => Expr<boolean | null>,
  ): JoinNeedsSelect<
    [
      ...J,
      Refs<
        { [K in keyof Row<T>]: Row<T>[K] },
        {
          [K in keyof Row<T>]: T["columns"][K] extends {
            readonly "~types": { readonly sqlClass: infer S extends SqlClass };
          }
            ? S
            : never;
        }
      >,
    ]
  >;
  /**
   * `on` sees the joined table's columns as declared. Later callbacks see each one nullable: a row
   * with no match there reads NULL in every column.
   */
  leftJoin<T extends Table>(
    table: T,
    on: (
      ...refs: [
        ...J,
        Refs<
          { [K in keyof Row<T>]: Row<T>[K] },
          {
            [K in keyof Row<T>]: T["columns"][K] extends {
              readonly "~types": { readonly sqlClass: infer S extends SqlClass };
            }
              ? S
              : never;
          }
        >,
      ]
    ) => Expr<boolean | null>,
  ): JoinNeedsSelect<
    [
      ...J,
      Refs<
        { [K in keyof Row<T>]: Row<T>[K] | null },
        {
          [K in keyof Row<T>]: T["columns"][K] extends {
            readonly "~types": { readonly sqlClass: infer S extends SqlClass };
          }
            ? S
            : never;
        }
      >,
    ]
  >;
};

/**
 * A select with a join, which is no Query until `select` names its columns: two tables can share
 * a column name. Each callback gets one parameter per table, in join order.
 */
export type JoinNeedsSelect<J extends readonly unknown[]> = Joins<J> & {
  /** The keys of the returned object name the output columns; each value is a column or an Expr. */
  select<S extends Selection>(pick: (...refs: J) => S): JoinedQuery<J, Selected<S>>;
  /** Combines with any earlier `where` using `and`. */
  where(pick: (...refs: J) => Expr<boolean | null>): JoinNeedsSelect<J>;
  /** Repeated calls append, so the first call's orderings sort first. */
  orderBy(pick: (...refs: J) => Orderable | readonly Orderable[]): JoinNeedsSelect<J>;
  /** A non-negative safe integer. A later call replaces an earlier one. */
  limit(count: number): JoinNeedsSelect<J>;
  /** A non-negative safe integer. A later call replaces an earlier one. */
  offset(count: number): JoinNeedsSelect<J>;
};

/** A joined select after `select`, which takes no more joins. `R` is the result row. */
export type JoinedQuery<J extends readonly unknown[], R> = Query<R> & {
  /** Replaces the earlier `select`. */
  select<S extends Selection>(pick: (...refs: J) => S): JoinedQuery<J, Selected<S>>;
  /** Combines with any earlier `where` using `and`. */
  where(pick: (...refs: J) => Expr<boolean | null>): JoinedQuery<J, R>;
  /** Repeated calls append, so the first call's orderings sort first. */
  orderBy(pick: (...refs: J) => Orderable | readonly Orderable[]): JoinedQuery<J, R>;
  /** A non-negative safe integer. A later call replaces an earlier one. */
  limit(count: number): JoinedQuery<J, R>;
  /** A non-negative safe integer. A later call replaces an earlier one. */
  offset(count: number): JoinedQuery<J, R>;
};
