import type { Row, Table } from "../definition/index.ts";
import { fragment, identifier, join, type Fragment } from "../sql/index.ts";
import {
  brand,
  columnIdentifier,
  refsOf,
  renderOutput,
  type Query,
  type Refs,
  type Selected,
  type Selection,
  type Statement,
} from "./from.ts";
import { decoderFor, encodeValue, withDecoder } from "./codecs.ts";

/** A column the database can fill: nullable, or with a default or an identity. */
type OptionalKeys<T extends Table> = {
  [K in keyof Row<T>]: null extends Row<T>[K]
    ? K
    : T["columns"][K]["~types"]["generated"] extends true
      ? K
      : never;
}[keyof Row<T>];

/** A NOT NULL column with neither a default nor an identity is required; the rest may be left out. */
export type NewRow<T extends Table> = {
  [K in Exclude<keyof Row<T>, OptionalKeys<T>>]: Row<T>[K];
} & {
  [K in OptionalKeys<T>]?: Row<T>[K];
};

/** Marks a query that can change several rows, which `client.one` can't take. */
type Many = { readonly "~many": true };

/** `Marker` is `Many` for a multi-row insert, carried over to what `returning` makes. */
export type InsertStatement<T extends Table, Marker = unknown> = Statement & {
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

function insertStatement<T extends Table>(
  table: T,
  rows: readonly Record<string, unknown>[],
): InsertStatement<T> {
  return brand<InsertStatement<T>>({
    returning(pick) {
      const picked = Object.entries(pick(refsOf(table)));
      if (picked.length === 0) throw new Error("returning needs at least one column");
      const named = picked.map(([alias, ref]): [string, string] => [alias, ref.name]);
      const outputs = named.map((output) => renderOutput(table, output));
      return withDecoder(
        brand({
          toSql() {
            return fragment`${insertInto(table, rows)} returning ${join(outputs, fragment`, `)}`.toSql();
          },
        }),
        decoderFor(table, named),
      );
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

export function insert<T extends Table>(
  table: T,
): {
  values(row: NewRow<T>): InsertStatement<T>;
  values(rows: readonly NewRow<T>[]): InsertStatement<T, Many>;
} {
  return {
    values(rows: NewRow<T> | readonly NewRow<T>[]): InsertStatement<T, Many> {
      const list: readonly Record<string, unknown>[] = Array.isArray(rows) ? rows : [rows];
      check(table, list);
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The marker exists only in types; the overloads decide it.
      return insertStatement(table, list) as InsertStatement<T, Many>;
    },
  };
}
