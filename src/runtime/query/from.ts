import type { Row, Table } from "../definition/index.ts";
import { fragment, identifier, join } from "../sql/index.ts";
import { decoderFor, withDecoder } from "./codecs.ts";
import {
  and,
  refsOf,
  renderOutput,
  type Output,
  type Predicate,
  type Refs,
  type Selected,
  type Selection,
} from "./refs.ts";
import { brand, type Query } from "./statement.ts";

export type SelectQuery<T extends Table, R> = Query<R> & {
  /** The keys of the returned object name the output columns. */
  select<S extends Selection>(pick: (columns: Refs<T>) => S): SelectQuery<T, Selected<S>>;
  /** Combines with any earlier `where` using `and`. */
  where(pick: (columns: Refs<T>) => Predicate): SelectQuery<T, R>;
};

type State = {
  readonly outputs: readonly Output[];
  readonly predicate?: Predicate;
};

function selectQuery<T extends Table, R>(table: T, state: State): SelectQuery<T, R> {
  const query = brand<SelectQuery<T, R>>({
    select(pick) {
      const picked = Object.entries(pick(refsOf(table)));
      if (picked.length === 0) throw new Error("select needs at least one column");
      const outputs = picked.map(([alias, ref]): Output => [alias, ref.name]);
      return selectQuery(table, { ...state, outputs });
    },
    where(pick) {
      const next = pick(refsOf(table));
      return selectQuery(table, {
        ...state,
        predicate: state.predicate ? and(state.predicate, next) : next,
      });
    },
    toSql() {
      const columns = join(
        state.outputs.map((output) => renderOutput(table, output)),
        fragment`, `,
      );
      const filter = state.predicate
        ? fragment` where ${state.predicate["~predicate"]()}`
        : fragment``;
      return fragment`select ${columns} from ${identifier(table.schema)}.${identifier(table.name)}${filter}`.toSql();
    },
  });
  return withDecoder(query, decoderFor(table, state.outputs));
}

export function from<T extends Table>(table: T): SelectQuery<T, Row<T>> {
  return selectQuery(table, {
    outputs: Object.keys(table.columns).map((name): Output => [name, name]),
  });
}
