import type { Table } from "../definition/index.ts";
import { fragment, join, type Fragment } from "../sql/index.ts";
import { assertColumns, cellOf, has, returning } from "./clauses.ts";
import { conflictTarget, targetNames, type ConflictRefs } from "./conflict-target.ts";
import type { Expr } from "./expr.ts";
import {
  and,
  assertComparableRefs,
  columnIdentifier,
  columnSql,
  refsOf,
  renderQualified,
  sourceOf,
  type Classes,
  type Refs,
  type Selected,
  type Selection,
} from "./refs.ts";
import { brand, unfinished, type Maybe, type Query, type Statement } from "./statement.ts";

/** An insert with its conflict action, which takes no second `onConflict`. */
export type ConflictStatement<T, Marker = unknown> = Statement & {
  /** Type-only: without `returning`, only `client.run` takes it. */
  readonly "~returns": "count";
  /**
   * The keys of the returned object name the output columns, read from the rows inserted or
   * updated, so a skipped row returns none. Each value is a column or an Expr.
   */
  returning<S extends Selection>(pick: (columns: Refs<T>) => S): Query<Selected<S>> & Marker;
};

/** A ref to a column holding `V` of SQL type class `S`; the optional brand lets NOT NULL fit nullable. */
type ColumnOf<V, S> = { readonly "~value"?: V; readonly "~class": S };

export type FilteredConflictUpdate<T, C extends Classes<T>, Marker = unknown> = ConflictStatement<
  T,
  Marker & Maybe
> & {
  /** Combines with the earlier `where` using `and`. */
  where(
    pick: (existing: Refs<T, C>, excluded: Refs<T, C>) => Expr<boolean | null>,
  ): FilteredConflictUpdate<T, C, Marker>;
};

export type ConflictUpdate<T, C extends Classes<T>, Marker = unknown> = ConflictStatement<
  T,
  Marker
> & {
  /**
   * Updates a conflicting row only where this holds, so a row may be skipped. `existing` is the
   * row in the table, `excluded` the one the insert proposed.
   */
  where(
    pick: (existing: Refs<T, C>, excluded: Refs<T, C>) => Expr<boolean | null>,
  ): FilteredConflictUpdate<T, C, Marker>;
};

/**
 * What a conflict does, which is no Statement until one is picked. Typed over the row `T`, its
 * SQL type classes `C`, and `A`, the keys of its `identity("always")` columns.
 */
export type OnConflict<T, C extends Classes<T>, A, Marker = unknown> = {
  /** Skips a row whose key is taken, so it returns none. */
  doNothing(): ConflictStatement<T, Marker & Maybe>;
  /**
   * Updates the row whose key is taken, under `set`'s rules: a value is a value of the column's
   * type, a column of the same type and class, such as `excluded.name`, or an Expr of that type,
   * which may name both rows. `undefined` skips a column, and an empty set throws.
   */
  doUpdate<
    S extends object & {
      readonly [K in keyof S]: K extends A
        ? `${K & string} is generated always, so update can't set it`
        : K extends keyof T
          ? T[K] | Expr<T[K]> | ColumnOf<T[K], C[K]> | undefined
          : `${K & string} is not a column`;
    },
  >(
    set: (existing: Refs<T, C>, excluded: Refs<T, C>) => S,
  ): ConflictUpdate<T, C, Marker>;
};

type Assignment = readonly [name: string, value: unknown];

type Rows<T, C extends Classes<T>> = readonly [existing: Refs<T, C>, excluded: Refs<T, C>];

/**
 * A value as `set` takes it, or a column of either row: Postgres casts a column to another only
 * where it compares the two, so an enum column takes no other enum's.
 */
function assignmentOf<T, C extends Classes<T>>(
  table: Table,
  [existing]: Rows<T, C>,
  [name, value]: Assignment,
): () => Fragment {
  const source = sourceOf(value);
  if (source === undefined) return () => cellOf(table, name, value);
  if (source.table !== table) {
    throw new Error(`doUpdate: "${name}" takes a column of another table`);
  }
  assertComparableRefs(Reflect.get(existing, name), value);
  return () => columnSql(source);
}

function conflictStatement<T>(table: Table, body: () => Fragment): ConflictStatement<T> {
  return brand<ConflictStatement<T>>({
    returning(pick) {
      return returning(table, pick, body);
    },
    toSql() {
      return body().toSql();
    },
  });
}

type Clause = (action: () => Fragment) => () => Fragment;

function filteredUpdate<T, C extends Classes<T>>(
  table: Table,
  clause: Clause,
  [rows, set]: readonly [Rows<T, C>, () => Fragment],
  predicate: Expr<boolean | null> | undefined,
): FilteredConflictUpdate<T, C> {
  if (predicate === undefined) {
    throw new Error("doUpdate.where callback must return a predicate");
  }
  const action = () => fragment`do update set ${set()} where ${predicate["~expr"]()}`;
  const parts: ConflictStatement<T> & Pick<FilteredConflictUpdate<T, C>, "where"> = {
    ...conflictStatement<T>(table, clause(action)),
    where(pick) {
      const next: Expr<boolean | null> | undefined = pick(...rows);
      return filteredUpdate(
        table,
        clause,
        [rows, set],
        next === undefined ? undefined : and(predicate, next),
      );
    },
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The marker exists only in types.
  return brand<ConflictStatement<T>>(parts) as FilteredConflictUpdate<T, C>;
}

function conflictUpdate<T, C extends Classes<T>>(
  table: Table,
  clause: Clause,
  rows: Rows<T, C>,
  values: object,
): ConflictUpdate<T, C> {
  const given: Record<string, unknown> = Object.fromEntries(Object.entries(values));
  assertColumns(table, Object.keys(given));
  const cells = Object.keys(given)
    .filter((name) => has(given, name))
    .map((name) => [name, assignmentOf(table, rows, [name, given[name]])] as const);
  if (cells.length === 0) throw new Error("doUpdate needs at least one column to set");
  const set = (): Fragment =>
    join(
      cells.map(([name, cell]) => fragment`${columnIdentifier(table, name)} = ${cell()}`),
      fragment`, `,
    );
  return brand<ConflictUpdate<T, C>>({
    ...conflictStatement<T>(
      table,
      clause(() => fragment`do update set ${set()}`),
    ),
    where(pick) {
      return filteredUpdate(table, clause, [rows, set], pick(...rows));
    },
  });
}

/**
 * The conflict actions for `target` on `table`. `insert` renders the insert the clause follows;
 * the clause renders with each ref qualified, since both rows share every column name.
 */
export function onConflict<T, C extends Classes<T>, A>(
  table: Table,
  target: (columns: ConflictRefs<T>) => unknown,
  insert: () => Fragment,
): OnConflict<T, C, A> {
  const on = conflictTarget(table, targetNames(table, target));
  const clause: Clause = (action) => () =>
    fragment`${insert()} on conflict ${on} ${renderQualified(true, action)}`;
  const rows: Rows<T, C> = [
    refsOf<T, C>(table, table.name, table.schema),
    refsOf<T, C>(table, "excluded"),
  ];
  const parts: OnConflict<T, C, A> & Pick<Statement, "toSql"> = {
    doNothing() {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The marker exists only in types.
      return conflictStatement<T>(
        table,
        clause(() => fragment`do nothing`),
      ) as ConflictStatement<T, Maybe>;
    },
    doUpdate(set) {
      const values: object | null | undefined = set(...rows);
      if (values === null || values === undefined) {
        throw new Error("doUpdate callback must return the columns to set");
      }
      return conflictUpdate(table, clause, rows, values);
    },
    // Hidden from the return type: a JavaScript caller that runs it reads why.
    toSql() {
      throw new Error("onConflict needs doNothing() or doUpdate() before it runs");
    },
  };
  return unfinished(parts);
}
