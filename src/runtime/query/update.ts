import type { Row, SqlClass, Table } from "../definition/index.ts";
import { fragment, identifier, join, type Fragment } from "../sql/index.ts";
import { assertColumns, cellOf, has, returning } from "./clauses.ts";
import {
  and,
  columnIdentifier,
  refsOf,
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
export type UpdateStatement<T, Marker = unknown> = Statement & {
  /** Type-only: a plain update reports a count, so only `client.run` takes it. */
  readonly "~returns": "count";
  /**
   * The keys of the returned object name the output columns, read from the updated rows, so they
   * hold the new values. Each value is a column or an Expr.
   */
  returning<S extends Selection>(pick: (columns: Refs<T>) => S): Query<Selected<S>> & Marker;
};

export type FilteredUpdate<T, C extends Classes<T>> = UpdateStatement<T> & {
  /** Combines with any earlier `where` using `and`. */
  where(pick: (columns: Refs<T, C>) => Expr<boolean | null>): FilteredUpdate<T, C>;
};

/**
 * An update with no rows picked yet, which is no Statement: call `where` for some rows or
 * `allRows` for every one. Typed over the row `T` and its SQL type classes `C`, so an error prints
 * the row's keys and names the call to make.
 */
export type UpdateNeedsWhereOrAllRows<T, C extends Classes<T> = Classes<T>> = {
  where(pick: (columns: Refs<T, C>) => Expr<boolean | null>): FilteredUpdate<T, C>;
  /** Every row. `client.one` can't take what `returning` makes of it. */
  allRows(): UpdateStatement<T, Many>;
};

/** An update with no columns to set yet, which is no Statement. `S` is the object `set` takes. */
export type UpdateNeedsSet<T, C extends Classes<T>, S> = {
  set(values: S): UpdateNeedsWhereOrAllRows<T, C>;
};

type Assignment = readonly [name: string, value: unknown];

function updateTable(table: Table): Fragment {
  return fragment`update ${identifier(table.schema)}.${identifier(table.name)}`;
}

function updateStatement<T>(
  table: Table,
  assignments: readonly Assignment[],
  predicate: Expr<boolean | null> | undefined,
): UpdateStatement<T> {
  const body = (): Fragment => {
    const list = join(
      assignments.map(
        ([name, value]) =>
          fragment`${columnIdentifier(table, name)} = ${cellOf(table, name, value)}`,
      ),
      fragment`, `,
    );
    const set = fragment`${updateTable(table)} set ${list}`;
    return predicate === undefined ? set : fragment`${set} where ${predicate["~expr"]()}`;
  };
  return brand<UpdateStatement<T>>({
    returning(pick) {
      return returning(table, pick, body);
    },
    toSql() {
      return body().toSql();
    },
  });
}

function filteredUpdate<T, C extends Classes<T>>(
  table: Table,
  assignments: readonly Assignment[],
  predicate: Expr<boolean | null> | undefined,
): FilteredUpdate<T, C> {
  if (predicate === undefined) {
    throw new Error("update.where callback must return a predicate");
  }
  return brand<FilteredUpdate<T, C>>({
    ...updateStatement<T>(table, assignments, predicate),
    where(pick) {
      const next: Expr<boolean | null> | undefined = pick(refsOf<T>(table));
      return filteredUpdate(
        table,
        assignments,
        next === undefined ? undefined : and(predicate, next),
      );
    },
  });
}

function needsWhereOrAllRows<T, C extends Classes<T>>(
  table: Table,
  assignments: readonly Assignment[],
): UpdateNeedsWhereOrAllRows<T, C> {
  const parts: UpdateNeedsWhereOrAllRows<T, C> & Pick<Statement, "toSql"> = {
    where(pick) {
      return filteredUpdate(table, assignments, pick(refsOf<T>(table)));
    },
    allRows() {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The marker exists only in types.
      return updateStatement<T>(table, assignments, undefined) as UpdateStatement<T, Many>;
    },
    // Hidden from the return type: a JavaScript caller that runs it reads why.
    toSql() {
      throw new Error("update needs where() or allRows() before it runs");
    },
  };
  return unfinished(parts);
}

/** A callback gets the table's columns and returns an Expr; any other value is the value itself. */
function resolve(table: Table, value: unknown): unknown {
  return typeof value === "function" ? Reflect.apply(value, undefined, [refsOf(table)]) : value;
}

function needsSet<T, C extends Classes<T>, S extends object>(
  table: Table,
): UpdateNeedsSet<T, C, S> {
  return unfinished({
    set(values: S): UpdateNeedsWhereOrAllRows<T, C> {
      const given: Record<string, unknown> = Object.fromEntries(Object.entries(values));
      assertColumns(table, Object.keys(given));
      const assignments = Object.keys(given)
        .filter((name) => has(given, name))
        .map((name): Assignment => [name, resolve(table, given[name])]);
      if (assignments.length === 0) throw new Error("update needs at least one column to set");
      return needsWhereOrAllRows(table, assignments);
    },
  });
}

/**
 * The row types are written out, not named `Row<T>`, so tsc prints their keys instead of the
 * Table. `set` takes every column, each optional, with `null` only on a nullable one. A column
 * that is `identity("always")` sits under a message key, so `set({ id: 5 })` prints why: Postgres
 * refuses it, and the key throws at run time as an unknown column. A value may also be an Expr of
 * its column's type, or a callback that returns one.
 */
export function update<T extends Table>(
  table: T,
): UpdateNeedsSet<
  { [K in keyof Row<T>]: Row<T>[K] },
  {
    [K in keyof Row<T>]: T["columns"][K] extends {
      readonly "~types": { readonly sqlClass: infer S extends SqlClass };
    }
      ? S
      : never;
  },
  {
    [
      K in keyof Row<T> as T["columns"][K] extends {
        readonly "~types": { readonly identityMode: infer Mode };
      }
        ? "always" extends Mode
          ? `${K & string} is generated always, so update can't set it`
          : K
        : K
    ]?:
      | Row<T>[K]
      | Expr<Row<T>[K]>
      | ((
          columns: Refs<
            { [P in keyof Row<T>]: Row<T>[P] },
            {
              [P in keyof Row<T>]: T["columns"][P] extends {
                readonly "~types": { readonly sqlClass: infer S extends SqlClass };
              }
                ? S
                : never;
            }
          >,
        ) => Expr<Row<T>[K]>);
  }
> {
  assertRegistered(table);
  return needsSet(table);
}
