import type { Row, SqlClass, Table } from "../definition/index.ts";
import { quoteIdentifier } from "../internal/index.ts";
import { fragment, identifier, join, type Fragment, type RenderedSql } from "../sql/index.ts";
import { aliasFor } from "./alias.ts";
import { withDecoder } from "./codecs.ts";
import { isExpr, type Expr } from "./expr.ts";
import type { Joins } from "./join.ts";
import { decodeOutputs, outputsOf, renderOutput, sortKeyOf, type Output } from "./clauses.ts";
import {
  and,
  refsOf,
  renderQualified,
  type Classes,
  type Orderable,
  type Refs,
  type Selected,
  type Selection,
} from "./refs.ts";
import { assertRegistered, brand, unfinished, type Query, type Statement } from "./statement.ts";

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

/**
 * What `from` returns: every column of one table, which takes joins until `select` or `pick` names
 * the output. Typed over the table's row `T` and its SQL type classes `C`, not its Table.
 */
export type FromQuery<T, C extends Classes<T> = Classes<T>> = Query<T> &
  Joins<[Refs<T, C>]> & {
    /** The keys of the returned object name the output columns; each value is a column or an Expr. */
    select<S extends Selection>(pick: (columns: Refs<T, C>) => S): SelectQuery<T, Selected<S>, C>;
    /** Selects each named column under its own key. The names are typed inline, so a wrong one prints the row's keys. */
    pick<K extends keyof T & string>(...names: [K, ...K[]]): SelectQuery<T, { [P in K]: T[P] }, C>;
    /** Combines with any earlier `where` using `and`. */
    where(pick: (columns: Refs<T, C>) => Expr<boolean | null>): FromQuery<T, C>;
    /** Repeated calls append, so the first call's orderings sort first. */
    orderBy(pick: (columns: Refs<T, C>) => Orderable | readonly Orderable[]): FromQuery<T, C>;
    /** A non-negative safe integer. A later call replaces an earlier one. */
    limit(count: number): FromQuery<T, C>;
    /** A non-negative safe integer. A later call replaces an earlier one. */
    offset(count: number): FromQuery<T, C>;
  };

/** One table of the `from` list, under the alias a joined query qualifies its columns by. */
type Source = { readonly table: Table; readonly alias: string };

type Joined = Source & { readonly keyword: Fragment; readonly on: Expr<boolean | null> };

type State = {
  readonly from: Source;
  readonly joins: readonly Joined[];
  readonly outputs: readonly Output[];
  readonly predicate?: Expr<boolean | null>;
  readonly orderings?: readonly (() => Fragment)[];
  readonly limit?: number;
  readonly offset?: number;
};

/** The public types give each callback its refs; at run time each gets one `Refs` per table. */
type Callback<V> = (...refs: Refs<Record<string, unknown>>[]) => V;

function isList(picked: Orderable | readonly Orderable[]): picked is readonly Orderable[] {
  return Array.isArray(picked);
}

function assertCount(clause: "limit" | "offset", count: number): void {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`${clause} needs a non-negative safe integer, got ${String(count)}`);
  }
}

/** Every column of `table`, or with `names`, one output per distinct name, each under its key. */
function outputsOfTable(
  table: Table,
  names: readonly string[] = Object.keys(table.columns),
): Output[] {
  return [...new Set(names)].map((key): Output => [key, { table, key, alias: table.name }]);
}

function pickedOutputs(table: Table, names: readonly string[]): Output[] {
  if (names.length === 0) throw new Error("pick needs at least one column");
  for (const name of names) {
    if (!Object.hasOwn(table.columns, name)) {
      throw new Error(
        `pick: ${quoteIdentifier(name)} is not a column of ${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)}`,
      );
    }
  }
  return outputsOfTable(table, names);
}

function refsFor(state: State): Refs<Record<string, unknown>>[] {
  return [state.from, ...state.joins].map(({ table, alias }) => refsOf(table, alias));
}

function sourceSql({ table, alias }: Source): Fragment {
  const name = fragment`${identifier(table.schema)}.${identifier(table.name)}`;
  return alias === table.name ? name : fragment`${name} as ${identifier(alias)}`;
}

/**
 * A joined query qualifies every column by its table's alias; a single table's SQL names them bare,
 * apart from its `order by` columns, which an output alias would otherwise capture.
 */
function sqlOf(state: State): RenderedSql {
  return renderQualified(state.joins.length > 0, () => {
    const columns = join(
      state.outputs.map((output) => renderOutput(output)),
      fragment`, `,
    );
    const joins = state.joins.map(
      ({ keyword, on, ...source }) =>
        fragment` ${keyword} ${sourceSql(source)} on ${on["~expr"]()}`,
    );
    const filter = state.predicate ? fragment` where ${state.predicate["~expr"]()}` : fragment``;
    const order = state.orderings
      ? fragment` order by ${join(
          state.orderings.map((sortKey) => sortKey()),
          fragment`, `,
        )}`
      : fragment``;
    const limit = state.limit === undefined ? fragment`` : fragment` limit ${state.limit}`;
    const offset = state.offset === undefined ? fragment`` : fragment` offset ${state.offset}`;
    return fragment`select ${columns} from ${sourceSql(state.from)}${join(joins, fragment``)}${filter}${order}${limit}${offset}`.toSql();
  });
}

/** `where`, `orderBy`, `limit`, and `offset` keep the builder's kind, which `next` makes; `select` ends it. */
function clauses(state: State, next: (state: State) => object) {
  return {
    select(pick: Callback<Selection>): object {
      const outputs = outputsOf("select", pick(...refsFor(state)));
      if (outputs.length === 0) throw new Error("select needs at least one column");
      return selected({ ...state, outputs });
    },
    where(pick: Callback<Expr<boolean | null>>): object {
      const added = pick(...refsFor(state));
      return next({ ...state, predicate: state.predicate ? and(state.predicate, added) : added });
    },
    orderBy(pick: Callback<Orderable | readonly Orderable[]>): object {
      const picked = pick(...refsFor(state));
      const terms = isList(picked) ? picked : [picked];
      if (terms.length === 0) throw new Error("orderBy needs at least one column");
      return next({
        ...state,
        orderings: [
          ...(state.orderings ?? []),
          ...terms.map((term, index) => sortKeyOf(term, index)),
        ],
      });
    },
    limit(count: number): object {
      assertCount("limit", count);
      return next({ ...state, limit: count });
    },
    offset(count: number): object {
      assertCount("offset", count);
      return next({ ...state, offset: count });
    },
  };
}

function joinWith(state: State, method: "innerJoin" | "leftJoin", keyword: Fragment) {
  return (table: Table, on: Callback<Expr<boolean | null> | undefined>): object => {
    assertRegistered(table);
    const used = new Set([state.from, ...state.joins].map(({ alias }) => alias));
    const source: Source = { table, alias: aliasFor(table.name, used) };
    const condition = on(...refsFor(state), refsOf(table, source.alias));
    if (!isExpr(condition)) throw new Error(`${method}'s on callback must return a predicate`);
    return needsSelect({
      ...state,
      joins: [...state.joins, { ...source, keyword, on: condition }],
    });
  };
}

function joinMethods(state: State) {
  return {
    innerJoin: joinWith(state, "innerJoin", fragment`inner join`),
    leftJoin: joinWith(state, "leftJoin", fragment`left join`),
  };
}

function statement<B extends Pick<Statement, "toSql">>(builder: B, outputs: readonly Output[]): B {
  brand<Statement>(builder);
  return withDecoder(builder, decodeOutputs(outputs));
}

/** After `select`: no more joins, and a single table keeps `pick`. */
function selected(state: State): object {
  const pick =
    state.joins.length === 0
      ? {
          pick: (...names: string[]) =>
            selected({ ...state, outputs: pickedOutputs(state.from.table, names) }),
        }
      : {};
  return statement(
    { ...clauses(state, selected), ...pick, toSql: () => sqlOf(state) },
    state.outputs,
  );
}

/** A joined builder before `select`, which a JavaScript caller can still hand to the client. */
function needsSelect(state: State): object {
  return unfinished({
    ...clauses(state, needsSelect),
    ...joinMethods(state),
    toSql(): never {
      throw new Error("A query with a join needs select() to name its columns before it runs");
    },
  });
}

function fromQuery(state: State): object {
  return statement(
    {
      ...clauses(state, fromQuery),
      ...joinMethods(state),
      pick: (...names: string[]) =>
        selected({ ...state, outputs: pickedOutputs(state.from.table, names) }),
      toSql: () => sqlOf(state),
    },
    state.outputs,
  );
}

/** The builder's methods follow the public type; their callbacks' refs are typed by the caller. */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- `Q` is the caller's return type, which the cast takes.
function typed<Q>(builder: object): Q {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The runtime builders take each public type's calls.
  return builder as Q;
}

/** The row type is written out, not named `Row<T>`, so tsc prints its keys instead of the Table. */
export function from<T extends Table>(
  table: T,
): FromQuery<
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
  return typed(
    fromQuery({ from: { table, alias: table.name }, joins: [], outputs: outputsOfTable(table) }),
  );
}
