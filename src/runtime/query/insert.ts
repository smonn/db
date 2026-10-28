import type { Row, Table } from "../definition/index.ts";
import { fragment, identifier, join, type Fragment } from "../sql/index.ts";
import {
  brand,
  columnIdentifier,
  refsOf,
  renderOutput,
  type Predicate,
  type Query,
  type Refs,
  type Selected,
  type Selection,
  type Statement,
} from "./from.ts";
import { decoderFor, encodeValue, withDecoder } from "./codecs.ts";

type NullableKeys<R> = { [K in keyof R]: null extends R[K] ? K : never }[keyof R];

/** NOT NULL columns are required; nullable columns may be left out. */
export type NewRow<T extends Table> = {
  [K in Exclude<keyof Row<T>, NullableKeys<Row<T>>>]: Row<T>[K];
} & {
  [K in NullableKeys<Row<T>>]?: Row<T>[K];
};

/** Marks a query that can change several rows, which `client.one` can't take. */
type Many = { readonly "~many": true };

/** A column as a conflict target names it; its type carries the key, so a target checks against the table's keys. */
type ConflictRef<K extends string> = { readonly "~column": K };

export type ConflictRefs<T extends Table> = {
  readonly [K in keyof T["columns"] & string]: ConflictRef<K>;
};

type TargetNames<G> = G extends readonly ConflictRef<infer K>[] ? K : never;

type JoinNames<G> = G extends readonly [ConflictRef<infer K>]
  ? K
  : G extends readonly [ConflictRef<infer K>, ...infer Rest]
    ? `${K}, ${JoinNames<Rest>}`
    : "";

/** The table's key sets that `N` names exactly, in any order. */
type Matching<U, N extends string> = U extends readonly [infer S, boolean]
  ? [S] extends [N]
    ? [N] extends [S]
      ? U
      : never
    : never
  : never;

type TargetCheck<T extends Table, G> = [Matching<T["~keys"], TargetNames<G>>] extends [never]
  ? { readonly [M in `(${JoinNames<G>}) is not a key of the table`]: never }
  : unknown;

/** A target only a partial unique index backs needs the index's predicate, or Postgres infers no arbiter. */
type PartialOnly<T extends Table, G> = [Matching<T["~keys"], TargetNames<G>>] extends [never]
  ? false
  : [Matching<T["~keys"], TargetNames<G>>] extends [readonly [string, true]]
    ? true
    : false;

export type ConflictAction<T extends Table, Marker> = {
  doNothing(): InsertStatement<T, Marker>;
};

/** A target only a partial index backs offers `where` alone, since Postgres needs the predicate to pick it. */
export type ConflictClause<T extends Table, G, Marker> =
  PartialOnly<T, G> extends true
    ? { where(pick: (columns: Refs<T>) => Predicate): ConflictAction<T, Marker> }
    : ConflictAction<T, Marker>;

/** `Marker` is `Many` for a multi-row insert, carried over to what `returning` makes. */
export type InsertStatement<T extends Table, Marker = unknown> = Statement & {
  /** Type-only: a plain insert reports a count, so only `client.run` takes it. */
  readonly "~returns": "count";
  /** The columns of a key; Postgres picks the constraint or unique index that matches them, in any order. */
  onConflict<const G extends readonly ConflictRef<keyof T["columns"] & string>[]>(
    target: (columns: ConflictRefs<T>) => G & TargetCheck<T, G>,
  ): ConflictClause<T, G, Marker>;
  /** The keys of the returned object name the output columns. */
  returning<S extends Selection>(pick: (columns: Refs<T>) => S): Query<Selected<S>> & Marker;
};

function has(row: Record<string, unknown>, name: string): boolean {
  return Object.hasOwn(row, name) && row[name] !== undefined;
}

/** A column no row gives a value for is left out; a row that skips a column gets its default. */
function insertRows(table: Table, rows: readonly Record<string, unknown>[]): Fragment {
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

function conflictRefsOf<T extends Table>(table: T): ConflictRefs<T> {
  const refs = Object.fromEntries(
    Object.keys(table.columns).map((name) => [name, { "~column": name }]),
  );
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- prototype stub: one ref per column key.
  return refs as unknown as ConflictRefs<T>;
}

function conflictClause(
  table: Table,
  rows: readonly Record<string, unknown>[],
  names: readonly string[],
): never {
  const columns = join(
    names.map((name) => columnIdentifier(table, name)),
    fragment`, `,
  );
  const action = (where: Fragment | undefined) => ({
    doNothing: () =>
      insertStatement(
        table,
        rows,
        where === undefined
          ? fragment`on conflict (${columns}) do nothing`
          : fragment`on conflict (${columns}) where ${where} do nothing`,
      ),
  });
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- prototype stub: the type picks which half applies.
  return {
    ...action(undefined),
    where: (pick: (columns: Refs<Table>) => Predicate) =>
      action(pick(refsOf(table))["~predicate"]()),
  } as never;
}

function insertStatement<T extends Table>(
  table: T,
  rows: readonly Record<string, unknown>[],
  conflict?: Fragment,
): InsertStatement<T> {
  const insertInto = (target: Table, given: readonly Record<string, unknown>[]): Fragment =>
    conflict === undefined
      ? insertRows(target, given)
      : fragment`${insertRows(target, given)} ${conflict}`;
  return brand<InsertStatement<T>>({
    onConflict(target) {
      const names = target(conflictRefsOf(table)).map((ref) => ref["~column"]);
      return conflictClause(table, rows, names);
    },
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
