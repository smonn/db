import type { Row, SqlClass, Table } from "../definition/index.ts";
import { fragment, identifier, type Fragment } from "../sql/index.ts";
import {
  and,
  refsOf,
  returning,
  type Classes,
  type Refs,
  type Selected,
  type Selection,
} from "./refs.ts";
import type { Expr } from "./expr.ts";
import {
  assertRegistered,
  brand,
  unfinished,
  type Many,
  type Query,
  type Statement,
} from "./statement.ts";

/**
 * Typed over the table's row `T`, not its Table, so an error prints the row's keys. `Marker` is
 * `Many` for `allRows()`, carried over to what `returning` makes.
 */
export type DeleteStatement<T, Marker = unknown> = Statement & {
  /** Type-only: a plain delete reports a count, so only `client.run` takes it. */
  readonly "~returns": "count";
  /**
   * The keys of the returned object name the output columns, read from the deleted rows. Each
   * value is a column or an Expr.
   */
  returning<S extends Selection>(pick: (columns: Refs<T>) => S): Query<Selected<S>> & Marker;
};

export type FilteredDelete<T, C extends Classes<T>> = DeleteStatement<T> & {
  /** Combines with any earlier `where` using `and`. */
  where(pick: (columns: Refs<T, C>) => Expr<boolean | null>): FilteredDelete<T, C>;
};

/**
 * A delete with no rows picked yet, which is no Statement: call `where` for some rows or `allRows`
 * for every one. Typed over the row `T` and its SQL type classes `C`, so an error prints the row's
 * keys and names the call to make.
 */
export type DeleteNeedsWhereOrAllRows<T, C extends Classes<T> = Classes<T>> = {
  where(pick: (columns: Refs<T, C>) => Expr<boolean | null>): FilteredDelete<T, C>;
  /** Every row. `client.one` can't take what `returning` makes of it. */
  allRows(): DeleteStatement<T, Many>;
};

function deleteFromTable(table: Table): Fragment {
  return fragment`delete from ${identifier(table.schema)}.${identifier(table.name)}`;
}

function deleteStatement<T>(
  table: Table,
  predicate: Expr<boolean | null> | undefined,
): DeleteStatement<T> {
  const body = (): Fragment =>
    predicate === undefined
      ? deleteFromTable(table)
      : fragment`${deleteFromTable(table)} where ${predicate["~expr"]()}`;
  return brand<DeleteStatement<T>>({
    returning(pick) {
      return returning(table, pick, body);
    },
    toSql() {
      return body().toSql();
    },
  });
}

function filteredDelete<T, C extends Classes<T>>(
  table: Table,
  predicate: Expr<boolean | null> | undefined,
): FilteredDelete<T, C> {
  if (predicate === undefined) {
    throw new Error("deleteFrom.where callback must return a predicate");
  }
  return brand<FilteredDelete<T, C>>({
    ...deleteStatement<T>(table, predicate),
    where(pick) {
      const next: Predicate | undefined = pick(refsOf<T>(table));
      return filteredDelete(table, next === undefined ? undefined : and(predicate, next));
    },
  });
}

function needsWhereOrAllRows<T, C extends Classes<T>>(
  table: Table,
): DeleteNeedsWhereOrAllRows<T, C> {
  const parts: DeleteNeedsWhereOrAllRows<T, C> & Pick<Statement, "toSql"> = {
    where(pick) {
      return filteredDelete(table, pick(refsOf<T>(table)));
    },
    allRows() {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The marker exists only in types.
      return deleteStatement<T>(table, undefined) as DeleteStatement<T, Many>;
    },
    // Hidden from the return type: a JavaScript caller that runs it reads why.
    toSql() {
      throw new Error("deleteFrom needs where() or allRows() before it runs");
    },
  };
  return unfinished(parts);
}

/** The row type is written out, not named `Row<T>`, so tsc prints its keys instead of the Table. */
export function deleteFrom<T extends Table>(
  table: T,
): DeleteNeedsWhereOrAllRows<
  { [K in keyof Row<T>]: Row<T>[K] },
  {
    [K in keyof Row<T>]: T["columns"][K] extends {
      readonly "~types": { readonly sqlClass: infer S extends SqlClass };
    }
      ? S
      : never;
  }
> {
  assertRegistered(table);
  return needsWhereOrAllRows(table);
}
