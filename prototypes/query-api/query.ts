// PROTOTYPE, throwaway. The builder both variants share: column objects with
// operator methods (ADR-0004), predicates, and SQL rendering. Variants differ
// only in how a built statement reaches the Driver.

import type { AnyTable, BaseValue, Columns, IsNotNull, KeyOf, NewRow, Row, Simplify, Table } from "./definition.ts";

export type Statement = { text: string; values: unknown[] };

// Stand-in for the runtime Driver port.
export type Driver = {
  query(statement: Statement): Promise<{ rows: Record<string, unknown>[]; count: number }>;
};

type Context = { values: unknown[] };

function param(ctx: Context, value: unknown): string {
  ctx.values.push(value);
  return `$${ctx.values.length}`;
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

// Predicates

export interface Predicate {
  readonly kind: "predicate";
  readonly render: (ctx: Context) => string;
  and(other: Predicate): Predicate;
  or(other: Predicate): Predicate;
  not(): Predicate;
}

function predicate(render: (ctx: Context) => string): Predicate {
  const self: Predicate = {
    kind: "predicate",
    render,
    and: (other) => predicate((ctx) => `(${render(ctx)} and ${other.render(ctx)})`),
    or: (other) => predicate((ctx) => `(${render(ctx)} or ${other.render(ctx)})`),
    not: () => predicate((ctx) => `not (${render(ctx)})`),
  };
  return self;
}

// Passed as the second argument to where, for those who prefer and(a, b) to a.and(b).
export const ops = {
  and: (...ps: [Predicate, ...Predicate[]]) => predicate((ctx) => `(${ps.map((p) => p.render(ctx)).join(" and ")})`),
  or: (...ps: [Predicate, ...Predicate[]]) => predicate((ctx) => `(${ps.map((p) => p.render(ctx)).join(" or ")})`),
  not: (p: Predicate) => p.not(),
};

export type Ops = typeof ops;

// Column objects

type Comparable = number | bigint | string | Date;

interface Ref<V, N extends boolean> {
  readonly kind: "ref";
  readonly name: string;
  // Type-only: the value a selected column yields.
  readonly "~value": N extends true ? V | null : V;
  eq(value: V | Ref<V, boolean>): Predicate;
  ne(value: V | Ref<V, boolean>): Predicate;
  in(values: readonly [V, ...V[]]): Predicate;
}

interface Ordered<V> {
  gt(value: V | Ref<V, boolean>): Predicate;
  gte(value: V | Ref<V, boolean>): Predicate;
  lt(value: V | Ref<V, boolean>): Predicate;
  lte(value: V | Ref<V, boolean>): Predicate;
}

interface Textual {
  like(pattern: string): Predicate;
  ilike(pattern: string): Predicate;
}

// Only nullable columns can be tested for null; eq(null) never type-checks.
interface NullTests {
  isNull(): Predicate;
  isNotNull(): Predicate;
}

export type ColumnRef<V, N extends boolean> = Ref<V, N> &
  ([V] extends [Comparable] ? Ordered<V> : unknown) &
  ([V] extends [string] ? Textual : unknown) &
  (N extends true ? NullTests : unknown);

export type AnyRef = Ref<any, boolean>;

export type Refs<T extends AnyTable> = {
  readonly [K in keyof T["columns"]]: ColumnRef<
    BaseValue<T["columns"][K]>,
    IsNotNull<T["columns"][K], K, KeyOf<T>> extends true ? false : true
  >;
};

function isRef(value: unknown): value is AnyRef {
  return typeof value === "object" && value !== null && (value as AnyRef).kind === "ref";
}

function operand(ctx: Context, value: unknown): string {
  return isRef(value) ? quote(value.name) : param(ctx, value);
}

function ref(name: string): AnyRef {
  const col = quote(name);
  const binary = (op: string) => (value: unknown) => predicate((ctx) => `${col} ${op} ${operand(ctx, value)}`);
  return {
    kind: "ref",
    name,
    eq: binary("="),
    ne: binary("<>"),
    gt: binary(">"),
    gte: binary(">="),
    lt: binary("<"),
    lte: binary("<="),
    like: binary("like"),
    ilike: binary("ilike"),
    in: (values: readonly unknown[]) => predicate((ctx) => `${col} in (${values.map((v) => param(ctx, v)).join(", ")})`),
    isNull: () => predicate(() => `${col} is null`),
    isNotNull: () => predicate(() => `${col} is not null`),
  } as unknown as AnyRef;
}

export function refsOf<T extends AnyTable>(table: T): Refs<T> {
  return Object.fromEntries(Object.keys(table.columns).map((name) => [name, ref(name)])) as Refs<T>;
}

// Selections

export type Selection = Record<string, AnyRef>;

export type Selected<S extends Selection> = Simplify<{ -readonly [K in keyof S]: S[K]["~value"] }>;

export type SelectArgs<T extends AnyTable> =
  | [pick: (columns: Refs<T>) => Selection]
  | (keyof T["columns"] & string)[];

// Each entry is [output name, column name].
export type Projection = [string, string][];

export function projection<T extends AnyTable>(table: T, args: SelectArgs<T>): Projection {
  const [first] = args;
  if (typeof first === "function") {
    return Object.entries(first(refsOf(table))).map(([alias, r]) => [alias, r.name]);
  }
  return (args as string[]).map((name) => [name, name]);
}

function renderProjection(projection: Projection): string {
  return projection.map(([alias, name]) => (alias === name ? quote(name) : `${quote(name)} as ${quote(alias)}`)).join(", ");
}

const tableName = (table: Table<Columns, readonly string[]>) => `${quote(table.schema)}.${quote(table.name)}`;

// SELECT

export type SelectState = {
  table: Table<Columns, readonly string[]>;
  where: Predicate[];
  projection: Projection;
};

export function selectState(table: Table<any, any>): SelectState {
  return { table, where: [], projection: Object.keys(table.columns).map((name) => [name, name]) };
}

export function renderSelect(state: SelectState): Statement {
  const ctx: Context = { values: [] };
  let text = `select ${renderProjection(state.projection)} from ${tableName(state.table)}`;
  if (state.where.length > 0) text += ` where ${state.where.map((p) => p.render(ctx)).join(" and ")}`;
  return { text, values: ctx.values };
}

// INSERT

export type InsertState = {
  table: Table<Columns, readonly string[]>;
  rows: Record<string, unknown>[];
  returning: Projection | undefined;
};

export function renderInsert(state: InsertState): Statement {
  if (state.rows.length === 0) throw new Error(`${state.table.schema}.${state.table.name}: insert needs at least one row`);
  const ctx: Context = { values: [] };
  const names = [...new Set(state.rows.flatMap((row) => Object.keys(row)))];
  let text = `insert into ${tableName(state.table)}`;
  if (names.length === 0) {
    text += " default values";
  } else {
    const tuples = state.rows.map(
      (row) => `(${names.map((n) => (row[n] === undefined ? "default" : param(ctx, row[n]))).join(", ")})`,
    );
    text += ` (${names.map(quote).join(", ")}) values ${tuples.join(", ")}`;
  }
  if (state.returning) text += ` returning ${renderProjection(state.returning)}`;
  return { text, values: ctx.values };
}

export type { NewRow, Row };

// Runtime builders. A driver makes them awaitable (variant B); without one
// they are plain values that a client runs (variant A).

async function rowsOf(driver: Driver, statement: Statement) {
  return (await driver.query(statement)).rows;
}

async function exactlyOne(driver: Driver, statement: Statement) {
  const rows = await rowsOf(driver, statement);
  if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`);
  return rows[0];
}

function awaitable(driver: Driver | undefined, toSql: () => Statement, run: (d: Driver) => Promise<unknown>, withOne: boolean) {
  if (!driver) return {};
  return {
    then: (resolve?: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => run(driver).then(resolve, reject),
    ...(withOne ? { one: () => exactlyOne(driver, toSql()) } : {}),
  };
}

export function makeSelect(state: SelectState, driver: Driver | undefined): object {
  const toSql = () => renderSelect(state);
  return {
    where: (filter: (columns: Refs<AnyTable>, o: Ops) => Predicate) =>
      makeSelect({ ...state, where: [...state.where, filter(refsOf(state.table), ops)] }, driver),
    select: (...args: SelectArgs<AnyTable>) => makeSelect({ ...state, projection: projection(state.table, args) }, driver),
    toSql,
    ...awaitable(driver, toSql, (d) => rowsOf(d, toSql()), true),
  };
}

export function makeInsert(state: InsertState, driver: Driver | undefined): object {
  const toSql = () => renderInsert(state);
  const returning = state.returning !== undefined;
  return {
    ...(returning
      ? {}
      : { returning: (...args: SelectArgs<AnyTable>) => makeInsert({ ...state, returning: projection(state.table, args) }, driver) }),
    toSql,
    ...awaitable(
      driver,
      toSql,
      async (d) => (returning ? rowsOf(d, toSql()) : { count: (await d.query(toSql())).count }),
      returning,
    ),
  };
}

export function toRows(rows: object): Record<string, unknown>[] {
  return (Array.isArray(rows) ? rows : [rows]) as Record<string, unknown>[];
}
