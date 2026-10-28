// Throwaway probe for #658 (map #652, #672): the decided join shape's runtime.
import type { Table } from "../definition/index.ts";
import { fragment, identifier, join, type Fragment } from "../sql/index.ts";
import { isTextArray } from "./array-text.ts";
import { decoderFor, encodeValue, withDecoder, type Decode } from "./codecs.ts";
import { and, brand, columnIdentifier, type Predicate, type Query } from "./from.ts";
import type { FromQuery } from "./probe-joins-types.ts";

export type {
  FromQuery,
  Joined,
  JoinRef,
  RefsOf,
  Selection,
  TableRefs,
} from "./probe-joins-types.ts";

type Source = {
  readonly table: Table;
  readonly alias: string;
  readonly kind: "from" | "inner" | "left";
  readonly on?: Callback;
};

type Callback = (...refs: never[]) => unknown;

type Output = readonly [alias: string, source: number, key: string];

type State = {
  readonly sources: readonly Source[];
  readonly wheres: readonly Callback[];
  readonly orders: readonly Callback[];
  readonly outputs?: readonly Output[];
};

type RefInfo = { readonly source: number; readonly key: string; readonly column: Fragment };

/** Tells a column operand from a value, since a jsonb value can be any object. */
const refInfo = new WeakMap<object, RefInfo>();

const predicate = (piece: () => Fragment): Predicate => ({ "~predicate": piece });

function infoOf(value: unknown): RefInfo | undefined {
  return typeof value === "object" && value !== null ? refInfo.get(value) : undefined;
}

function refOf(table: Table, source: number, key: string, column: Fragment): object {
  const compare = (operator: Fragment, operand: unknown) =>
    predicate(() => {
      const other = infoOf(operand);
      const right = other ? other.column : fragment`${encodeValue(table, key, operand)}`;
      return fragment`${column} ${operator} ${right}`;
    });
  const ref = {
    name: key,
    eq: (operand: unknown) => compare(fragment`=`, operand),
    ne: (operand: unknown) => compare(fragment`<>`, operand),
    gt: (operand: unknown) => compare(fragment`>`, operand),
    gte: (operand: unknown) => compare(fragment`>=`, operand),
    lt: (operand: unknown) => compare(fragment`<`, operand),
    lte: (operand: unknown) => compare(fragment`<=`, operand),
    isNull: () => predicate(() => fragment`${column} is null`),
    isNotNull: () => predicate(() => fragment`${column} is not null`),
  };
  refInfo.set(ref, { source, key, column });
  return ref;
}

/** A single-table query names columns bare, as `from` does; a joined one qualifies each by alias. */
function refsFor(sources: readonly Source[]): never[] {
  const qualify = sources.length > 1;
  const refs = sources.map(({ table, alias }, index) =>
    Object.fromEntries(
      Object.keys(table.columns).map((key) => {
        const bare = columnIdentifier(table, key);
        const column = qualify ? fragment`${identifier(alias)}.${bare}` : bare;
        return [key, refOf(table, index, key, column)];
      }),
    ),
  );
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Each callback's parameters are the refs, typed by the builder.
  return refs as never[];
}

/** The table's SQL name, or with `_2`, `_3` when an earlier entry holds it. */
export function aliasFor(name: string, used: ReadonlySet<string>): string {
  if (!used.has(name)) return name;
  let n = 2;
  while (used.has(`${name}_${n}`)) n += 1;
  return `${name}_${n}`;
}

function predicateOf(pick: Callback, refs: never[], what: string): Predicate {
  const result = pick(...refs);
  if (typeof result !== "object" || result === null || !("~predicate" in result)) {
    throw new Error(`${what} must return a comparison, and, or, or not`);
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Checked above.
  return result as Predicate;
}

function outputsOf(picked: unknown): readonly Output[] {
  if (typeof picked !== "object" || picked === null)
    throw new Error("select must return an object");
  const entries = Object.entries(picked);
  if (entries.length === 0) throw new Error("select needs at least one column");
  return entries.map(([alias, ref]): Output => {
    const info = infoOf(ref);
    if (!info) throw new Error(`select's "${alias}" is not a column`);
    return [alias, info.source, info.key];
  });
}

function sourceAt(sources: readonly Source[], index: number): Source {
  const source = sources[index];
  if (source === undefined) throw new Error(`No table at position ${index}`);
  return source;
}

function renderOutput(sources: readonly Source[], [alias, index, key]: Output): Fragment {
  const { table, alias: tableAlias } = sourceAt(sources, index);
  const name = table.columnNames[key] ?? key;
  const bare = identifier(name);
  const column = sources.length > 1 ? fragment`${identifier(tableAlias)}.${bare}` : bare;
  const definition = table.columns[key];
  if (definition !== undefined && isTextArray(definition)) {
    return fragment`${column}::text as ${identifier(alias)}`;
  }
  return alias === name ? column : fragment`${column} as ${identifier(alias)}`;
}

function sourceSql({ table, alias }: Source): Fragment {
  const target = fragment`${identifier(table.schema)}.${identifier(table.name)}`;
  return alias === table.name ? target : fragment`${target} as ${identifier(alias)}`;
}

function render(state: State): Fragment {
  const { sources } = state;
  const refs = refsFor(sources);
  const outputs = state.outputs ?? defaultOutputs(sources);
  const columns = join(
    outputs.map((output) => renderOutput(sources, output)),
    fragment`, `,
  );
  const [first, ...rest] = sources;
  if (first === undefined) throw new Error("A query needs a table");
  const joins = rest.map((source) => {
    const kind = source.kind === "left" ? fragment`left join` : fragment`inner join`;
    if (source.on === undefined) throw new Error(`A join on ${source.alias} needs on`);
    const on = predicateOf(source.on, refs, "on")["~predicate"]();
    return fragment` ${kind} ${sourceSql(source)} on ${on}`;
  });
  const wheres = state.wheres.map((pick) => predicateOf(pick, refs, "where"));
  const [firstWhere, ...moreWheres] = wheres;
  const filter =
    firstWhere === undefined
      ? fragment``
      : fragment` where ${(moreWheres.length > 0 ? and(firstWhere, ...moreWheres) : firstWhere)["~predicate"]()}`;
  const orderings = state.orders.flatMap((pick) => {
    const picked = pick(...refs);
    return (Array.isArray(picked) ? picked : [picked]).map((ref: unknown) => {
      const info = infoOf(ref);
      if (!info) throw new Error("orderBy must return columns");
      return info.column;
    });
  });
  const order =
    orderings.length === 0 ? fragment`` : fragment` order by ${join(orderings, fragment`, `)}`;
  return fragment`select ${columns} from ${sourceSql(first)}${join(joins, fragment``)}${filter}${order}`;
}

function defaultOutputs(sources: readonly Source[]): readonly Output[] {
  if (sources.length > 1) throw new Error("A query with a join needs select to name its columns");
  const table = sources[0]?.table;
  return table ? Object.keys(table.columns).map((key): Output => [key, 0, key]) : [];
}

/** Decodes each output by its own table, so codecs, casing, and `.name()` resolve per table. */
function decoderOf(sources: readonly Source[], outputs: readonly Output[]): Decode | undefined {
  const steps = sources.flatMap(({ table }, index) => {
    const own = outputs.filter(([, source]) => source === index).map(([a, , k]) => [a, k] as const);
    const decode = decoderFor(table, own);
    return decode ? [decode] : [];
  });
  if (steps.length === 0) return undefined;
  return (row) => steps.reduce((next, step) => step(next), row);
}

function builder(state: State): object {
  const sources = state.sources;
  const joinWith =
    (kind: "inner" | "left") =>
    (table: Table, on: Callback): object => {
      if (typeof on !== "function") throw new Error(`${kind}Join needs an on callback`);
      const alias = aliasFor(table.name, new Set(sources.map((source) => source.alias)));
      return builder({ ...state, sources: [...sources, { table, alias, kind, on }] });
    };
  const selected = (outputs: readonly Output[]): object => {
    const next = { ...state, outputs };
    const query = brand<Query<unknown>>({ toSql: () => render(next).toSql() });
    return withDecoder(Object.assign(query, selectedMethods(next)), decoderOf(sources, outputs));
  };
  const methods = {
    where: (pick: Callback) => builder({ ...state, wheres: [...state.wheres, pick] }),
    orderBy: (pick: Callback) => builder({ ...state, orders: [...state.orders, pick] }),
    select: (pick: Callback) => selected(outputsOf(pick(...refsFor(sources)))),
    innerJoin: joinWith("inner"),
    leftJoin: joinWith("left"),
    // Refuses a JS caller who runs a joined builder without select.
    toSql: () => render(state).toSql(),
  };
  if (sources.length > 1) return methods;
  const table = sources[0]?.table;
  const all = defaultOutputs(sources);
  const single = {
    ...methods,
    pick: (...keys: string[]) => selected(keys.map((key): Output => [key, 0, key])),
  };
  return table ? withDecoder(single, decoderOf(sources, all)) : single;
}

function selectedMethods(state: State): object {
  return {
    where: (pick: Callback) => reselect({ ...state, wheres: [...state.wheres, pick] }),
    orderBy: (pick: Callback) => reselect({ ...state, orders: [...state.orders, pick] }),
    select: (pick: Callback) =>
      reselect({ ...state, outputs: outputsOf(pick(...refsFor(state.sources))) }),
  };
}

function reselect(state: State): object {
  const query = brand<Query<unknown>>({ toSql: () => render(state).toSql() });
  return withDecoder(
    Object.assign(query, selectedMethods(state)),
    decoderOf(state.sources, state.outputs ?? []),
  );
}

export function from<T extends Table>(table: T): FromQuery<T> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The builder's methods follow FromQuery.
  return builder({
    sources: [{ table, alias: table.name, kind: "from" }],
    wheres: [],
    orders: [],
  }) as FromQuery<T>;
}
