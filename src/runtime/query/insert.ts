import type { KeySet, Row, SqlClass, Table } from "../definition/index.ts";
import { fragment, identifier, join, type Fragment } from "../sql/index.ts";
import type { Expr } from "./expr.ts";
import { assertColumns, cellOf, has, returning } from "./clauses.ts";
import type { ConflictRef, ConflictRefs, TargetCheck } from "./conflict-target.ts";
import { onConflict, type ConflictStatement, type OnConflict } from "./on-conflict.ts";
import { columnIdentifier, type Classes } from "./refs.ts";
import { assertRegistered, brand, unfinished, type Many } from "./statement.ts";

/** A column the database can fill: nullable, or with a default or an identity. */
type OptionalKeys<T extends Table> = {
  [K in keyof Row<T>]: null extends Row<T>[K]
    ? K
    : T["columns"][K]["~types"]["generated"] extends true
      ? K
      : never;
}[keyof Row<T>];

type RequiredKeys<T extends Table> = Exclude<keyof Row<T>, OptionalKeys<T>>;

/** A NOT NULL column with neither a default nor an identity is required; the rest may be left out. */
export type NewRow<T extends Table> = {
  [K in RequiredKeys<T>]: Row<T>[K];
} & {
  [K in OptionalKeys<T>]?: Row<T>[K];
};

/**
 * Typed over the table's row `T`, not its Table, so an error prints the row's keys. `Marker` is
 * `Many` for a multi-row insert, carried over to what `returning` makes. `C` holds the row's SQL
 * type classes, `U` the table's key sets, and `A` the keys of its `identity("always")` columns.
 */
export type InsertStatement<
  T,
  Marker = unknown,
  C extends Classes<T> = Classes<T>,
  U extends KeySet = never,
  A = never,
> = ConflictStatement<T, Marker> & {
  /**
   * Resolves a conflict on a key the Definition declares: the callback lists its columns, in any
   * order, and `doNothing()` or `doUpdate(...)` follows. A key only a partial unique index backs
   * takes that index's `where`. Postgres never finds a conflict on a NULL in a nullable key
   * (unless it is `nullsNotDistinct`), so that row inserts. A key repeated within one
   * `valuesMany` fails under `doUpdate`, and `doNothing` keeps the first of those rows.
   */
  onConflict<const G extends readonly ConflictRef<keyof T & string>[]>(
    target: (columns: ConflictRefs<T>) => G & TargetCheck<U, G>,
  ): OnConflict<T, C, A, Marker>;
};

/** A column no row gives a value for is left out; a row that skips a column gets its default. */
function insertInto(table: Table, rows: readonly Record<string, unknown>[]): Fragment {
  const target = fragment`insert into ${identifier(table.schema)}.${identifier(table.name)}`;
  const given = Object.keys(table.columns).filter((name) => rows.some((row) => has(row, name)));
  // Postgres takes `values (default)` for a row with nothing to set.
  const names = given.length > 0 ? given : Object.keys(table.columns).slice(0, 1);
  const tuples = rows.map((row) => {
    const cells = names.map((name) =>
      has(row, name) ? cellOf(table, name, row[name]) : fragment`default`,
    );
    return fragment`(${join(cells, fragment`, `)})`;
  });
  const columns = join(
    names.map((name) => columnIdentifier(table, name)),
    fragment`, `,
  );
  return fragment`${target} (${columns}) values ${join(tuples, fragment`, `)}`;
}

function insertStatement<T, C extends Classes<T>, U extends KeySet, A>(
  table: Table,
  rows: readonly Record<string, unknown>[],
): InsertStatement<T, unknown, C, U, A> {
  const body = () => insertInto(table, rows);
  return brand<InsertStatement<T, unknown, C, U, A>>({
    returning(pick) {
      return returning(table, pick, body);
    },
    toSql() {
      return body().toSql();
    },
    onConflict(target) {
      return onConflict<T, C, A>(table, target, body);
    },
  });
}

function check(table: Table, rows: readonly Record<string, unknown>[]): void {
  if (rows.length === 0) throw new Error("insert needs at least one row");
  if (Object.keys(table.columns).length === 0)
    throw new Error("insert needs a table with a column");
  for (const row of rows) assertColumns(table, Object.keys(row));
}

/**
 * An insert with no rows yet, which is no Statement: call `values` for one row or `valuesMany` for
 * an array. `N` is the row each takes, typed inline so a wrong key is named, not blamed on another.
 */
export type InsertNeedsValues<
  T,
  N,
  C extends Classes<T> = Classes<T>,
  U extends KeySet = never,
  A = never,
> = {
  values(row: N): InsertStatement<T, unknown, C, U, A>;
  valuesMany(rows: readonly N[]): InsertStatement<T, Many, C, U, A>;
};

function needsValues<
  T,
  N extends Record<string, unknown>,
  C extends Classes<T>,
  U extends KeySet,
  A,
>(table: Table): InsertNeedsValues<T, N, C, U, A> {
  return unfinished({
    values(row: N): InsertStatement<T, unknown, C, U, A> {
      const list: readonly Record<string, unknown>[] = [row];
      check(table, list);
      return insertStatement(table, list);
    },
    valuesMany(rows: readonly N[]): InsertStatement<T, Many, C, U, A> {
      check(table, rows);
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The marker exists only in types.
      return insertStatement<T, C, U, A>(table, rows) as InsertStatement<T, Many, C, U, A>;
    },
  });
}

/**
 * The row types are written out, not named `Row<T>` and `NewRow<T>`, so tsc prints their keys
 * instead of the Table. A new row's value may also be an Expr of its column's type. The classes,
 * key sets, and identity always keys are for `onConflict`.
 */
export function insert<T extends Table>(
  table: T,
): InsertNeedsValues<
  { [K in keyof Row<T>]: Row<T>[K] },
  {
    [
      K in keyof ({ [P in RequiredKeys<T>]: Row<T>[P] } & { [P in OptionalKeys<T>]?: Row<T>[P] })
    ]: ({
      [P in RequiredKeys<T>]: Row<T>[P] | Expr<Row<T>[P]>;
    } & { [P in OptionalKeys<T>]?: Row<T>[P] | Expr<Row<T>[P]> })[K];
  },
  {
    [K in keyof Row<T>]: T["columns"][K] extends {
      readonly "~types": { readonly sqlClass: infer S extends SqlClass };
    }
      ? S
      : never;
  },
  T["~keys"],
  {
    [K in keyof Row<T>]: T["columns"][K] extends {
      readonly "~types": { readonly identityMode: infer Mode };
    }
      ? "always" extends Mode
        ? K
        : never
      : never;
  }[keyof Row<T>]
> {
  assertRegistered(table);
  return needsValues(table);
}
