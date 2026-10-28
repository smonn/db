import type { Row, Table } from "../definition/index.ts";
import { fragment, identifier, join, type Fragment } from "../sql/index.ts";
import { brand, columnIdentifier, refsOf, renderOutput } from "./from.ts";
import { decoderFor, encodeValue, withDecoder } from "./codecs.ts";
import {
  conflictAction,
  conflictRefsOf,
  conflictTarget,
  type ConflictAction,
  type ConflictRef,
  type ConflictRefs,
  type ConflictStatement,
  type TargetCheck,
} from "./on-conflict.ts";

type NullableKeys<R> = { [K in keyof R]: null extends R[K] ? K : never }[keyof R];

/** NOT NULL columns are required; nullable columns may be left out. */
export type NewRow<T extends Table> = {
  [K in Exclude<keyof Row<T>, NullableKeys<Row<T>>>]: Row<T>[K];
} & {
  [K in NullableKeys<Row<T>>]?: Row<T>[K];
};

/** Marks a query that can change several rows, which `client.one` can't take. */
type Many = { readonly "~many": true };

/** `Marker` is `Many` for a multi-row insert, carried over to what `returning` makes. */
export type InsertStatement<T extends Table, Marker = unknown> = ConflictStatement<T, Marker> & {
  /** The columns of a key; Postgres picks the constraint or unique index that matches them, in any order. */
  onConflict<const G extends readonly ConflictRef<keyof T["columns"] & string>[]>(
    target: (columns: ConflictRefs<T>) => G & TargetCheck<T, G>,
  ): ConflictAction<T, Marker>;
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

/** `conflict` renders the `on conflict` clause, when one follows the rows. */
function insertStatement(
  table: Table,
  rows: readonly Record<string, unknown>[],
  conflict?: () => Fragment,
): ConflictStatement<Table, unknown> {
  const render = (): Fragment =>
    conflict === undefined
      ? insertRows(table, rows)
      : fragment`${insertRows(table, rows)} ${conflict()}`;
  return brand<ConflictStatement<Table, unknown>>({
    returning(pick) {
      const picked = Object.entries(pick(refsOf(table)));
      if (picked.length === 0) throw new Error("returning needs at least one column");
      const named = picked.map(([alias, ref]): [string, string] => [alias, ref.name]);
      const outputs = named.map((output) => renderOutput(table, output));
      return withDecoder(
        brand({
          toSql() {
            return fragment`${render()} returning ${join(outputs, fragment`, `)}`.toSql();
          },
        }),
        decoderFor(table, named),
      );
    },
    toSql() {
      return render().toSql();
    },
  });
}

function upsertable<T extends Table>(
  table: T,
  rows: readonly Record<string, unknown>[],
): InsertStatement<T> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- prototype: the types pick which clause applies.
  return {
    ...insertStatement(table, rows),
    onConflict(target: (columns: ConflictRefs<T>) => readonly { readonly "~column": string }[]) {
      const names = target(conflictRefsOf(table)).map((ref) => ref["~column"]);
      return conflictAction(table, conflictTarget(table, names), (conflict) =>
        insertStatement(table, rows, conflict),
      );
    },
  } as unknown as InsertStatement<T>;
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
      return upsertable(table, list) as InsertStatement<T, Many>;
    },
  };
}
