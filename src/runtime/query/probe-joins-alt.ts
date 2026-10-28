// Throwaway probe for #658: alternatives to positional refs, run on the decided builder's runtime.
import type { Table } from "../definition/index.ts";
import type { Predicate, Query, Selected } from "./from.ts";
import { from, type Joined, type RefsOf, type Selection, type TableRefs } from "./probe-joins.ts";

// Alternative A: named refs, keyed by an alias the caller gives: `from({ u: users })`.

type Named = Readonly<Record<string, Joined>>;

export type NamedRefs<S extends Named> = {
  readonly [K in keyof S]: S[K] extends readonly [infer T extends Table, infer N extends boolean]
    ? TableRefs<T, N>
    : never;
};

/** One alias per call; an alias in use names itself in the error. */
type Source<S extends Named, A extends string, T extends Table> = A extends keyof S
  ? { readonly [K in A]: T } & { readonly [K in `${A} is already in use`]: never }
  : { readonly [K in A]: T };

type With<S extends Named, A extends string, T extends Table, N extends boolean> = S & {
  readonly [K in A]: readonly [T, N];
};

export type NamedBuilder<S extends Named> = {
  innerJoin<A extends string, T extends Table>(
    source: Source<S, A, T>,
    on: (t: NamedRefs<With<S, A, T, false>>) => Predicate,
  ): NamedBuilder<With<S, A, T, false>>;
  leftJoin<A extends string, T extends Table>(
    source: Source<S, A, T>,
    on: (t: NamedRefs<With<S, A, T, false>>) => Predicate,
  ): NamedBuilder<With<S, A, T, true>>;
  where(pick: (t: NamedRefs<S>) => Predicate): NamedBuilder<S>;
  select<R extends Selection>(pick: (t: NamedRefs<S>) => R): Query<Selected<R>>;
};

type Callback = (...refs: never[]) => unknown;
type Runtime = Record<string, (...args: never[]) => unknown>;

/** Hands a named callback the positional refs, keyed by alias. */
const adaptTo =
  (names: readonly string[], pick: (t: Record<string, unknown>) => unknown): Callback =>
  (...refs) =>
    pick(Object.fromEntries(names.map((key, index) => [key, refs[index]])));

function named(keys: readonly string[], inner: Runtime): object {
  const adapt = (pick: (t: Record<string, unknown>) => unknown) => adaptTo(keys, pick);
  const join =
    (method: "innerJoin" | "leftJoin") =>
    (source: Record<string, Table>, on: (t: Record<string, unknown>) => unknown): object => {
      const entries = Object.entries(source);
      const [entry] = entries;
      if (entries.length !== 1 || entry === undefined) throw new Error(`${method} takes one alias`);
      const [alias, table] = entry;
      if (keys.includes(alias)) throw new Error(`${alias} is already in use`);
      const next = [...keys, alias];
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The decided builder's method.
      const call = inner[method] as (t: Table, on: Callback) => Runtime;
      return named(next, call(table, adaptTo(next, on)));
    };
  return {
    innerJoin: join("innerJoin"),
    leftJoin: join("leftJoin"),
    where: (pick: (t: Record<string, unknown>) => unknown) =>
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The decided builder's method.
      named(keys, (inner["where"] as (p: Callback) => Runtime)(adapt(pick))),
    select: (pick: (t: Record<string, unknown>) => unknown) =>
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The decided builder's method.
      (inner["select"] as (p: Callback) => unknown)(adapt(pick)),
  };
}

export function fromNamed<A extends string, T extends Table>(source: {
  readonly [K in A]: T;
}): NamedBuilder<{ readonly [K in A]: readonly [T, false] }> {
  const entries: [string, Table][] = Object.entries(source);
  const [entry] = entries;
  if (entries.length !== 1 || entry === undefined) throw new Error("from takes one alias");
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Follows NamedBuilder.
  return named([entry[0]], from(entry[1]) as unknown as Runtime) as NamedBuilder<{
    readonly [K in A]: readonly [T, false];
  }>;
}

// Alternative C: one `join` with a kind argument.

export type KindBuilder<J extends readonly Joined[]> = {
  join<T extends Table, K extends "inner" | "left" = "inner">(
    table: T,
    on: (...refs: RefsOf<[...J, [T, false]]>) => Predicate,
    kind?: K,
  ): KindBuilder<[...J, [T, K extends "left" ? true : false]]>;
  select<R extends Selection>(pick: (...refs: RefsOf<J>) => R): Query<Selected<R>>;
};

function kinded(inner: Runtime): object {
  return {
    join: (table: Table, on: Callback, kind: "inner" | "left" = "inner") => {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The decided builder's method.
      const call = inner[kind === "left" ? "leftJoin" : "innerJoin"] as (
        t: Table,
        on: Callback,
      ) => Runtime;
      return kinded(call(table, on));
    },
    select: inner["select"],
  };
}

export function fromKind<T extends Table>(table: T): KindBuilder<[[T, false]]> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Follows KindBuilder.
  return kinded(from(table) as unknown as Runtime) as KindBuilder<[[T, false]]>;
}
