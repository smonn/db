import type { Row, SqlClass, Table } from "../definition/index.ts";
import { fragment, identifier, join } from "../sql/index.ts";
import { withDecoder } from "./codecs.ts";
import type { Expr } from "./expr.ts";
import {
  and,
  decodeOutputs,
  outputsOf,
  refsOf,
  renderOrderBy,
  renderOutput,
  type Classes,
  type Orderable,
  type Output,
  type Refs,
  type Selected,
  type Selection,
} from "./refs.ts";
import { assertRegistered, brand, type Query } from "./statement.ts";

/**
 * Typed over the table's row `T` and its SQL type classes `C`, not its Table, so an error prints
 * the row's keys; `R` is the result row.
 */
export type SelectQuery<T, R = T, C extends Classes<T> = Classes<T>> = Query<R> & {
  /** The keys of the returned object name the output columns; each value is a column or an Expr. */
  select<S extends Selection>(pick: (columns: Refs<T, C>) => S): SelectQuery<T, Selected<S>, C>;
  /** Selects each named column under its own key. The names are typed inline, so a wrong one prints the row's keys. */
  pick<K extends keyof T & string>(...names: [K, ...K[]]): SelectQuery<T, { [P in K]: T[P] }, C>;
  /** Combines with any earlier `where` using `and`. */
  where(pick: (columns: Refs<T, C>) => Expr<boolean | null>): SelectQuery<T, R, C>;
  /** Repeated calls append, so the first call's orderings sort first. */
  orderBy(pick: (columns: Refs<T, C>) => Orderable | readonly Orderable[]): SelectQuery<T, R, C>;
  /** A non-negative safe integer. A later call replaces an earlier one. */
  limit(count: number): SelectQuery<T, R, C>;
  /** A non-negative safe integer. A later call replaces an earlier one. */
  offset(count: number): SelectQuery<T, R, C>;
};

type State = {
  readonly outputs: readonly Output[];
  readonly predicate?: Expr<boolean | null>;
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

/** One output per distinct name, each under its own key. */
function pickedOutputs(table: Table, names: readonly string[]): Output[] {
  if (names.length === 0) throw new Error("pick needs at least one column");
  for (const name of names) {
    if (!Object.hasOwn(table.columns, name)) {
      throw new Error(`pick: "${name}" is not a column of "${table.schema}"."${table.name}"`);
    }
  }
  return [...new Set(names)].map((key): Output => [key, { table, key, alias: table.name }]);
}

function selectQuery<T, R, C extends Classes<T>>(table: Table, state: State): SelectQuery<T, R, C> {
  const query = brand<SelectQuery<T, R, C>>({
    select(pick) {
      const outputs = outputsOf(table, pick(refsOf<T>(table)));
      if (outputs.length === 0) throw new Error("select needs at least one column");
      return selectQuery(table, { ...state, outputs });
    },
    pick(...names) {
      return selectQuery(table, { ...state, outputs: pickedOutputs(table, names) });
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
        state.outputs.map((output) => renderOutput(output)),
        fragment`, `,
      );
      const filter = state.predicate ? fragment` where ${state.predicate["~expr"]()}` : fragment``;
      const order = state.orderings
        ? fragment` order by ${renderOrderBy(table, state.orderings)}`
        : fragment``;
      const limit = state.limit === undefined ? fragment`` : fragment` limit ${state.limit}`;
      const offset = state.offset === undefined ? fragment`` : fragment` offset ${state.offset}`;
      return fragment`select ${columns} from ${identifier(table.schema)}.${identifier(table.name)}${filter}${order}${limit}${offset}`.toSql();
    },
  });
  return withDecoder(query, decodeOutputs(state.outputs));
}

/** The row type is written out, not named `Row<T>`, so tsc prints its keys instead of the Table. */
export function from<T extends Table>(
  table: T,
): SelectQuery<
  { [K in keyof Row<T>]: Row<T>[K] },
  { [K in keyof Row<T>]: Row<T>[K] },
  {
    [K in keyof Row<T>]: T["columns"][K] extends {
      readonly "~types": { readonly sqlClass: infer S extends SqlClass };
    }
      ? S
      : never;
  }
> {
  assertRegistered(table);
  return selectQuery(table, {
    outputs: Object.keys(table.columns).map((key): Output => [
      key,
      { table, key, alias: table.name },
    ]),
  });
}
