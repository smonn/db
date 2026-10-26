import type { Action, ActionKind } from "./actions.ts";

/**
 * The phases `order` sorts actions into, in order. `docs/architecture/diff-engine.md` (Ordering)
 * numbers them by position here and lists the kinds each holds.
 *
 * Fixed phases suffice because every dependency edge runs between kinds, never between two objects
 * of one kind: a foreign key needs its tables and keys, a column its enum or domain, a domain its
 * enum. Phases place each edge's two ends apart, so they never meet a cycle. A topological sort
 * waits for a kind that references its own kind, such as a view or function (v0.5).
 */
const PHASES = [
  "rename",
  "rename by payload",
  "drop key or index",
  "drop column or table",
  "create or alter schema or type",
  "create or alter table",
  "add key or index",
  "drop type",
  "drop schema",
] as const;

type Phase = (typeof PHASES)[number];

/** A kind's phase, then its rank within the phase; kinds of equal rank keep catalog order. */
type Place = readonly [phase: Phase, rank: number];

/** One `Place` per kind of `K`; the test widens `K` to prove a new kind has to name its phase. */
export type PlaceTable<K extends string> = { readonly [A in K]: Place };

/**
 * Ranks follow #381's listed order, and leave gaps for kinds that land later. A domain is created
 * after an enum it may be over, and dropped before one.
 *
 * Within its phase, each drop runs before the changes it would block: Postgres refuses to add an
 * identity to a column that has a default or isn't NOT NULL, to drop NOT NULL from an identity
 * column, and to retype a column whose default can't be cast. Keys drop first and add last, so a
 * changed key is rebuilt around the column changes it spans.
 */
export const PLACES: PlaceTable<ActionKind> = {
  "rename table": ["rename", 0],
  "rename column": ["rename", 2],
  "rename enum": ["rename", 4],
  "rename enum label": ["rename", 5],
  "rename domain": ["rename", 6],
  "rename enum aside": ["rename", 8],
  "rename domain check": ["rename by payload", 0],
  "drop foreign key": ["drop key or index", 0],
  "drop index": ["drop key or index", 1],
  "drop unique": ["drop key or index", 2],
  "drop primary key": ["drop key or index", 3],
  "drop column": ["drop column or table", 0],
  "drop table": ["drop column or table", 1],
  "create schema": ["create or alter schema or type", 0],
  "create enum": ["create or alter schema or type", 2],
  "create domain": ["create or alter schema or type", 3],
  "add enum value": ["create or alter schema or type", 5],
  "drop domain check": ["create or alter schema or type", 6],
  "alter domain default": ["create or alter schema or type", 7],
  "alter domain not null": ["create or alter schema or type", 7],
  "add domain check": ["create or alter schema or type", 8],
  "create table": ["create or alter table", 0],
  "add column": ["create or alter table", 1],
  "drop default": ["create or alter table", 2],
  "drop identity": ["create or alter table", 3],
  "drop expression": ["create or alter table", 3],
  "alter type": ["create or alter table", 4],
  "swap retype": ["create or alter table", 4],
  "set not null": ["create or alter table", 5],
  "drop not null": ["create or alter table", 5],
  "set default": ["create or alter table", 6],
  "set expression": ["create or alter table", 6],
  "add identity": ["create or alter table", 7],
  "set identity mode": ["create or alter table", 7],
  "add primary key": ["add key or index", 0],
  "add unique": ["add key or index", 1],
  "add index": ["add key or index", 2],
  "add foreign key": ["add key or index", 3],
  "drop domain": ["drop type", 0],
  "drop enum": ["drop type", 2],
  "drop enum aside": ["drop type", 2],
  "drop schema": ["drop schema", 0],
};

/**
 * Sorts by phase, then rank within it. The sort is stable, so ties keep catalog order, which
 * `introspect` sorts by name for schemas, tables, and constraints and by position for columns, so
 * new columns follow the Definition. Drops keep the `from` catalog's order and everything else the
 * `to` catalog's.
 */
export function order(actions: readonly Action[]): Action[] {
  return actions.toSorted((a, b) => {
    const [phaseA, rankA] = PLACES[a.kind];
    const [phaseB, rankB] = PLACES[b.kind];
    return PHASES.indexOf(phaseA) - PHASES.indexOf(phaseB) || rankA - rankB;
  });
}
