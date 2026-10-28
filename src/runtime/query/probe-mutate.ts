// PROBE (#657, #672): the decided update and delete shapes. Throwaway; never merged to main.
import type { Row, Table } from "../definition/index.ts";
import { quoteIdentifier } from "../internal/index.ts";
import { fragment, identifier, join, type Fragment } from "../sql/index.ts";
import { decoderFor, encodeValue, withDecoder } from "./codecs.ts";
import {
  and,
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

export type Many = { readonly "~many": true };

/** An update or delete that runs: only `client.run` takes it until `returning` makes it a query. */
export type MutationStatement<T extends Table, Marker = unknown> = Statement & {
  /** Type-only: without `returning` it reports a count, so only `client.run` takes it. */
  readonly "~returns": "count";
  /** New values for update, deleted values for delete. */
  returning<S extends Selection>(pick: (columns: Refs<T>) => S): Query<Selected<S>> & Marker;
};

export type FilteredMutation<T extends Table> = MutationStatement<T> & {
  /** Combines with any earlier `where` using `and`. */
  where(pick: (columns: Refs<T>) => Predicate): FilteredMutation<T>;
};

/** Not a Statement: no client takes it until `where` or `allRows` picks the rows. */
export type NeedsWhere<T extends Table> = {
  where(pick: (columns: Refs<T>) => Predicate): FilteredMutation<T>;
  /** Every row; `client.one` can't take what it returns. */
  allRows(): MutationStatement<T, Many>;
};

type Output = readonly [alias: string, column: string];

const qualified = (table: Table): string =>
  `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)}`;

function returningQuery(table: Table, head: () => Fragment, outputs: readonly Output[]) {
  if (outputs.length === 0) throw new Error("returning needs at least one column");
  const rendered = () =>
    join(
      outputs.map((output) => renderOutput(table, output)),
      fragment`, `,
    );
  return withDecoder(
    brand<Query<unknown>>({
      toSql: () => fragment`${head()} returning ${rendered()}`.toSql(),
    }),
    decoderFor(table, outputs),
  );
}

export function mutation<T extends Table>(
  table: T,
  head: () => Fragment,
  predicate: Predicate | undefined,
): FilteredMutation<T> {
  const full = () =>
    predicate === undefined ? head() : fragment`${head()} where ${predicate["~predicate"]()}`;
  return brand<FilteredMutation<T>>({
    where(pick) {
      const next = pick(refsOf(table));
      return mutation(table, head, predicate ? and(predicate, next) : next);
    },
    returning(pick) {
      const outputs = Object.entries(pick(refsOf(table))).map(([alias, ref]): Output => [
        alias,
        ref.name,
      ]);
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- PROBE: the row type is the caller's selection.
      return returningQuery(table, full, outputs) as never;
    },
    toSql: () => full().toSql(),
  });
}

function needsWhere<T extends Table>(table: T, verb: string, head: () => Fragment): NeedsWhere<T> {
  const parts = {
    where: (pick: (columns: Refs<T>) => Predicate) => mutation(table, head, undefined).where(pick),
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The marker exists only in types.
    allRows: () => mutation(table, head, undefined) as unknown as MutationStatement<T, Many>,
    // Hidden from the type: a JavaScript caller that runs it reads why.
    toSql: () => {
      throw new Error(`${verb} needs where() or allRows() before it runs`);
    },
  };
  return parts;
}

export function deleteFrom<T extends Table>(table: T): NeedsWhere<T> {
  return needsWhere(table, "deleteFrom", deleteHead(table));
}

function checkSet(table: Table, values: Record<string, unknown>): string[] {
  const names = Object.keys(values).filter((name) => values[name] !== undefined);
  for (const name of names) {
    const column = table.columns[name];
    if (!Object.hasOwn(table.columns, name) || column === undefined) {
      throw new Error(`"${name}" is not a column of ${qualified(table)}`);
    }
    if (column.state.identity === "always") {
      throw new Error(
        `update can't set ${quoteIdentifier(name)} of ${qualified(table)}: it is generated always`,
      );
    }
  }
  if (names.length === 0) throw new Error("update needs at least one column to set");
  return names;
}

/** Checks `values` now; encodes them when the statement renders, so a throwing codec rejects the query. */
export function setHead(table: Table, values: object): () => Fragment {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- PROBE: a row object read by key.
  const given = values as Record<string, unknown>;
  const names = checkSet(table, given);
  return () => {
    const assignments = names.map(
      (name) =>
        fragment`${columnIdentifier(table, name)} = ${encodeValue(table, name, given[name])}`,
    );
    return fragment`update ${identifier(table.schema)}.${identifier(table.name)} set ${join(assignments, fragment`, `)}`;
  };
}

export const deleteHead = (table: Table) => (): Fragment =>
  fragment`delete from ${identifier(table.schema)}.${identifier(table.name)}`;

export function update<T extends Table>(
  table: T,
): {
  set(values: {
    [
      K in keyof T["columns"] as T["columns"][K]["~types"]["generated"] extends "always" ? never : K
    ]?: Row<T>[K];
  }): NeedsWhere<T>;
} {
  return {
    set(values) {
      return needsWhere(table, "update", setHead(table, values));
    },
  };
}
