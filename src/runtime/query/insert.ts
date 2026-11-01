import type { Row, Table } from "../definition/index.ts";
import { fragment, identifier, join, type Fragment } from "../sql/index.ts";
import { encodeValue } from "./codecs.ts";
import { columnIdentifier, returning, type Refs, type Selected, type Selection } from "./refs.ts";
import { assertRegistered, brand, type Many, type Query, type Statement } from "./statement.ts";

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
 * `Many` for a multi-row insert, carried over to what `returning` makes.
 */
export type InsertStatement<T, Marker = unknown> = Statement & {
  /** Type-only: a plain insert reports a count, so only `client.run` takes it. */
  readonly "~returns": "count";
  /** The keys of the returned object name the output columns. */
  returning<S extends Selection>(pick: (columns: Refs<T>) => S): Query<Selected<S>> & Marker;
};

function has(row: Record<string, unknown>, name: string): boolean {
  return Object.hasOwn(row, name) && row[name] !== undefined;
}

/** A column no row gives a value for is left out; a row that skips a column gets its default. */
function insertInto(table: Table, rows: readonly Record<string, unknown>[]): Fragment {
  const target = fragment`insert into ${identifier(table.schema)}.${identifier(table.name)}`;
  const given = Object.keys(table.columns).filter((name) => rows.some((row) => has(row, name)));
  // Postgres takes `values (default)` for a row with nothing to set.
  const names = given.length > 0 ? given : Object.keys(table.columns).slice(0, 1);
  const tuples = rows.map((row) => {
    const cells = names.map((name) =>
      has(row, name) ? fragment`${encodeValue(table, name, row[name])}` : fragment`default`,
    );
    return fragment`(${join(cells, fragment`, `)})`;
  });
  const columns = join(
    names.map((name) => columnIdentifier(table, name)),
    fragment`, `,
  );
  return fragment`${target} (${columns}) values ${join(tuples, fragment`, `)}`;
}

function insertStatement<T>(
  table: Table,
  rows: readonly Record<string, unknown>[],
): InsertStatement<T> {
  return brand<InsertStatement<T>>({
    returning(pick) {
      return returning(table, pick, () => insertInto(table, rows));
    },
    toSql() {
      return insertInto(table, rows).toSql();
    },
  });
}

function check(table: Table, rows: readonly Record<string, unknown>[]): void {
  if (rows.length === 0) throw new Error("insert needs at least one row");
  if (Object.keys(table.columns).length === 0)
    throw new Error("insert needs a table with a column");
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!Object.hasOwn(table.columns, key)) {
        throw new Error(`"${key}" is not a column of "${table.schema}"."${table.name}"`);
      }
    }
  }
}

/**
 * An insert with no rows yet, which is no Statement: call `values` for one row or `valuesMany` for
 * an array. `N` is the row each takes, typed inline so a wrong key is named, not blamed on another.
 */
export type InsertNeedsValues<T, N> = {
  values(row: N): InsertStatement<T>;
  valuesMany(rows: readonly N[]): InsertStatement<T, Many>;
};

function needsValues<T, N extends Record<string, unknown>>(table: Table): InsertNeedsValues<T, N> {
  return {
    values(row: N): InsertStatement<T> {
      const list: readonly Record<string, unknown>[] = [row];
      check(table, list);
      return insertStatement(table, list);
    },
    valuesMany(rows: readonly N[]): InsertStatement<T, Many> {
      check(table, rows);
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The marker exists only in types.
      return insertStatement(table, rows) as InsertStatement<T, Many>;
    },
  };
}

/** The row types are written out, not named `Row<T>` and `NewRow<T>`, so tsc prints their keys instead of the Table. */
export function insert<T extends Table>(
  table: T,
): InsertNeedsValues<
  { [K in keyof Row<T>]: Row<T>[K] },
  {
    [
      K in keyof ({ [P in RequiredKeys<T>]: Row<T>[P] } & { [P in OptionalKeys<T>]?: Row<T>[P] })
    ]: ({
      [P in RequiredKeys<T>]: Row<T>[P];
    } & { [P in OptionalKeys<T>]?: Row<T>[P] })[K];
  }
> {
  assertRegistered(table);
  return needsValues(table);
}
