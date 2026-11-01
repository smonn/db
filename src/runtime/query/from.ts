import type { Row, Table } from "../definition/index.ts";
import { fragment, identifier, join } from "../sql/index.ts";
import { decoderFor, withDecoder } from "./codecs.ts";
import {
  and,
  refsOf,
  renderOrderBy,
  renderOutput,
  type Orderable,
  type Output,
  type Predicate,
  type Refs,
  type Selected,
  type Selection,
} from "./refs.ts";
import { assertRegistered, brand, type Query } from "./statement.ts";

/** Typed over the table's row `T`, not its Table, so an error prints the row's keys; `R` is the result row. */
export type SelectQuery<T, R = T> = Query<R> & {
  /** The keys of the returned object name the output columns. */
  select<S extends Selection>(pick: (columns: Refs<T>) => S): SelectQuery<T, Selected<S>>;
  /** Combines with any earlier `where` using `and`. */
  where(pick: (columns: Refs<T>) => Predicate): SelectQuery<T, R>;
  /** Repeated calls append, so the first call's orderings sort first. */
  orderBy(pick: (columns: Refs<T>) => Orderable | readonly Orderable[]): SelectQuery<T, R>;
  /** A non-negative safe integer. A later call replaces an earlier one. */
  limit(count: number): SelectQuery<T, R>;
  /** A non-negative safe integer. A later call replaces an earlier one. */
  offset(count: number): SelectQuery<T, R>;
};

type State = {
  readonly outputs: readonly Output[];
  readonly predicate?: Predicate;
  readonly orderings?: readonly Orderable[];
  readonly limit?: number;
  readonly offset?: number;
};

function isList(picked: Orderable | readonly Orderable[]): picked is readonly Orderable[] {
  return Array.isArray(picked);
}

function assertCount(clause: "limit" | "offset", count: number): void {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`${clause} needs a non-negative safe integer, got ${String(count)}`);
  }
}

function selectQuery<T, R>(table: Table, state: State): SelectQuery<T, R> {
  const query = brand<SelectQuery<T, R>>({
    select(pick) {
      const picked = Object.entries(pick(refsOf<T>(table)));
      if (picked.length === 0) throw new Error("select needs at least one column");
      const outputs = picked.map(([alias, ref]): Output => [alias, ref.name]);
      return selectQuery(table, { ...state, outputs });
    },
    where(pick) {
      const next = pick(refsOf<T>(table));
      return selectQuery(table, {
        ...state,
        predicate: state.predicate ? and(state.predicate, next) : next,
      });
    },
    orderBy(pick) {
      const picked = pick(refsOf<T>(table));
      const terms = isList(picked) ? picked : [picked];
      if (terms.length === 0) throw new Error("orderBy needs at least one column");
      return selectQuery(table, { ...state, orderings: [...(state.orderings ?? []), ...terms] });
    },
    limit(count) {
      assertCount("limit", count);
      return selectQuery(table, { ...state, limit: count });
    },
    offset(count) {
      assertCount("offset", count);
      return selectQuery(table, { ...state, offset: count });
    },
    toSql() {
      const columns = join(
        state.outputs.map((output) => renderOutput(table, output)),
        fragment`, `,
      );
      const filter = state.predicate
        ? fragment` where ${state.predicate["~predicate"]()}`
        : fragment``;
      const order = state.orderings
        ? fragment` order by ${renderOrderBy(table, state.orderings)}`
        : fragment``;
      const limit = state.limit === undefined ? fragment`` : fragment` limit ${state.limit}`;
      const offset = state.offset === undefined ? fragment`` : fragment` offset ${state.offset}`;
      return fragment`select ${columns} from ${identifier(table.schema)}.${identifier(table.name)}${filter}${order}${limit}${offset}`.toSql();
    },
  });
  return withDecoder(query, decoderFor(table, state.outputs));
}

/** The row type is written out, not named `Row<T>`, so tsc prints its keys instead of the Table. */
export function from<T extends Table>(table: T): SelectQuery<{ [K in keyof Row<T>]: Row<T>[K] }> {
  assertRegistered(table);
  return selectQuery(table, {
    outputs: Object.keys(table.columns).map((name): Output => [name, name]),
  });
}
