import {
  arePayloadsEqual,
  childrenOf,
  type Catalog,
  type Fact,
  type GeneratedPayload,
  type Key,
} from "../catalog/index.ts";
import { hazardsOf, order, render, type Action, type Catalogs } from "./actions.ts";
import type { Hazard } from "./hazards.ts";

export type Diff = {
  /** Each statement follows one `-- hazard: <kind>` comment per Hazard it carries. */
  readonly sql: string;
  readonly hazards: readonly Hazard[];
};

/** The SQL that turns a database with catalog `from` into one with catalog `to`. */
export function diff(from: Catalog, to: Catalog): Diff {
  const catalogs = { from, to };
  // A column Postgres can't convert in place drops and adds back, so each side sees it, what it
  // holds, and the keys on it as absent from the other.
  const rebuilt = rebuiltColumns(catalogs);
  const keptFrom = without(from, rebuilt);
  const keptTo = without(to, rebuilt);
  const actions: Action[] = [];
  for (const [key, fact] of from) {
    const after = keptTo.get(key);
    if (after === undefined) actions.push(...dropped(fact, keptTo));
    // A key can't change in place, nor can a fact change kind: the old one drops here, and
    // `altered` adds the new one.
    else if (
      fact.kind !== after.kind ||
      (isKey(fact) && !arePayloadsEqual(fact.payload, after.payload))
    )
      actions.push(...dropped(fact, keptTo));
    // Postgres refuses to retype a column whose default can't be cast, so it goes first.
    else if (fact.kind === "default" && retyped(fact.parent, catalogs)) {
      actions.push({ kind: "drop default", fact });
    }
  }
  for (const [key, fact] of to) {
    const before = keptFrom.get(key);
    actions.push(
      ...(before === undefined ? created(fact, keptFrom) : altered(before, fact, catalogs)),
    );
  }
  const hazards: Hazard[] = [];
  const sql = order(actions)
    .map((action) => {
      const statement = render(action, catalogs);
      const kinds = hazardsOf(action, catalogs);
      hazards.push(...kinds.map((kind) => ({ kind, statement })));
      return `${kinds.map((kind) => `-- hazard: ${kind}\n`).join("")}${statement}\n`;
    })
    .join("\n");
  return { sql, hazards };
}

type Kind = Fact["kind"];
type FactOf<K extends Kind> = Extract<Fact, { readonly kind: K }>;
type KeyFact = FactOf<"primary key" | "unique">;

/**
 * What the diff does with one kind of fact. Every field is required, so a new `Fact` kind fails to
 * compile until its author states each decision.
 */
export type Handling<F extends { readonly kind: string }> = {
  /** Whether dropping the parent drops this fact too, so it needs no action of its own. */
  readonly parentDropCovers: boolean;
  readonly drop: (fact: F) => Action[];
  /** Whether creating the parent creates this fact inline, so it needs no action of its own. */
  readonly parentCreateCovers: boolean;
  readonly create: (fact: F) => Action[];
  /** Compares two facts of this kind at one key, after the source pass dropped any other kind. */
  readonly alter: (before: F, after: F, catalogs: Catalogs) => Action[];
};

/** One `Handling` per kind of `F`; the test widens `F` to prove a new kind has to fill each field. */
export type HandlingTable<F extends { readonly kind: string }> = {
  readonly [K in F["kind"]]: Handling<Extract<F, { readonly kind: K }>>;
};

export const HANDLING: HandlingTable<Fact> = {
  // A schema drop without CASCADE refuses to drop what it holds, so its tables drop on their own.
  schema: {
    parentDropCovers: false,
    drop: (fact) => [{ kind: "drop schema", fact }],
    parentCreateCovers: false,
    create: (fact) => [{ kind: "create schema", fact }],
    alter: () => [],
  },
  table: {
    parentDropCovers: false,
    drop: (fact) => [{ kind: "drop table", fact }],
    parentCreateCovers: false,
    create: (fact) => [{ kind: "create table", fact }],
    alter: () => [],
  },
  column: {
    parentDropCovers: true,
    drop: (fact) => [{ kind: "drop column", fact }],
    parentCreateCovers: true,
    create: (fact) => [{ kind: "add column", fact }],
    alter: (before, after) => {
      const actions: Action[] = [];
      if (before.payload.type !== after.payload.type) {
        actions.push({ kind: "alter type", fact: after, before });
      }
      if (before.payload.notNull !== after.payload.notNull) {
        actions.push({
          kind: after.payload.notNull ? "set not null" : "drop not null",
          fact: after,
        });
      }
      return actions;
    },
  },
  default: {
    parentDropCovers: true,
    drop: (fact) => [{ kind: "drop default", fact }],
    parentCreateCovers: true,
    create: (fact) => [{ kind: "set default", fact }],
    alter: (before, after, catalogs) =>
      // A retyped column's default was dropped first, whether or not it changed.
      arePayloadsEqual(before.payload, after.payload) && !retyped(after.parent, catalogs)
        ? []
        : [{ kind: "set default", fact: after }],
  },
  identity: {
    parentDropCovers: true,
    drop: (fact) => [{ kind: "drop identity", fact }],
    parentCreateCovers: true,
    create: (fact) => [{ kind: "add identity", fact }],
    alter: (before, after) =>
      arePayloadsEqual(before.payload, after.payload)
        ? []
        : [{ kind: "set identity mode", fact: after }],
  },
  generated: {
    parentDropCovers: true,
    // Only a stored column converts in place; `rebuiltColumns` sends the rest to `drop column`.
    drop: (fact) => [{ kind: "drop expression", fact }],
    parentCreateCovers: true,
    // Postgres can't make a plain column generated, so a new expression is on a rebuilt column,
    // which `add column` renders whole.
    create: () => [],
    alter: (before, after) =>
      arePayloadsEqual(before.payload, after.payload)
        ? []
        : [{ kind: "set expression", fact: after }],
  },
  "primary key": {
    parentDropCovers: true,
    drop: (fact) => [{ kind: "drop primary key", fact }],
    // Never inline: CREATE TABLE silently drops a unique that duplicates the primary key.
    parentCreateCovers: false,
    create: (fact) => [{ kind: "add primary key", fact }],
    alter: alteredKey,
  },
  unique: {
    parentDropCovers: true,
    drop: (fact) => [{ kind: "drop unique", fact }],
    parentCreateCovers: false,
    create: (fact) => [{ kind: "add unique", fact }],
    alter: alteredKey,
  },
};

/** A key can't change in place: a new payload re-adds it, after the source pass dropped the old one. */
function alteredKey(before: KeyFact, after: KeyFact, { from }: Catalogs): Action[] {
  return arePayloadsEqual(before.payload, after.payload) ? [] : created(after, from);
}

function handlingOf<K extends Kind>(fact: FactOf<K>): Handling<FactOf<K>> {
  // The types prove every kind has handling; at run time, a kind this diff predates has none.
  if (!Object.hasOwn(HANDLING, fact.kind)) {
    throw new Error(`Unhandled fact kind ${JSON.stringify(fact.kind)}`);
  }
  return HANDLING[fact.kind];
}

/**
 * Dropping a table or column drops what it holds, so its children emit nothing. A schema drop
 * without CASCADE refuses to drop what it holds, so its tables drop on their own first.
 */
function dropped(fact: Fact, to: Catalog): Action[] {
  const handling = handlingOf(fact);
  return handling.parentDropCovers && parentAbsent(fact, to) ? [] : handling.drop(fact);
}

function created(fact: Fact, from: Catalog): Action[] {
  const handling = handlingOf(fact);
  return handling.parentCreateCovers && parentAbsent(fact, from) ? [] : handling.create(fact);
}

/** Whether `fact` has a parent that `catalog` lacks: the parent was dropped, or is new. */
function parentAbsent(fact: Fact, catalog: Catalog): boolean {
  return fact.parent !== undefined && !catalog.has(fact.parent);
}

function altered(before: Fact, after: Fact, catalogs: Catalogs): Action[] {
  // The old kind was dropped in the source pass, whatever the payloads say.
  if (before.kind !== after.kind) return created(after, catalogs.from);
  return handlingOf(before).alter(before, after, catalogs);
}

function isKey(fact: Fact): fact is Extract<Fact, { readonly kind: "primary key" | "unique" }> {
  return fact.kind === "primary key" || fact.kind === "unique";
}

/**
 * The columns `ALTER COLUMN` can't convert: Postgres can't make a plain column generated, switch
 * a column between stored and virtual, or drop the expression of a virtual one.
 */
function rebuiltColumns({ from, to }: Catalogs): ReadonlyMap<Key, Fact> {
  const rebuilt = new Map<Key, Fact>();
  for (const [key, before] of from) {
    const after = to.get(key);
    if (before.kind !== "column" || after?.kind !== "column") continue;
    const was = generation(from, before);
    const now = generation(to, after);
    if (was?.storage === now?.storage) continue;
    if (now === undefined && was?.storage === "stored") continue;
    rebuilt.set(key, after);
  }
  return rebuilt;
}

function generation(catalog: Catalog, column: Fact): GeneratedPayload | undefined {
  const child = childrenOf(catalog, column).find((fact) => fact.kind === "generated");
  return child?.kind === "generated" ? child.payload : undefined;
}

/** `catalog` without the rebuilt columns, the facts under them, and the keys that name them. */
function without(catalog: Catalog, rebuilt: ReadonlyMap<Key, Fact>): Catalog {
  const columns = [...rebuilt.values()];
  return new Map(
    [...catalog].filter(
      ([key, fact]) =>
        !rebuilt.has(key) &&
        !(fact.parent !== undefined && rebuilt.has(fact.parent)) &&
        !(
          isKey(fact) &&
          columns.some((column) => column.parent === fact.parent && namesColumn(fact, column.name))
        ),
    ),
  );
}

function namesColumn(
  key: Extract<Fact, { readonly kind: "primary key" | "unique" }>,
  column: string,
): boolean {
  return key.kind === "unique"
    ? key.payload.column === column
    : key.payload.columns.includes(column);
}

function retyped(column: Key, { from, to }: Catalogs): boolean {
  const before = from.get(column);
  const after = to.get(column);
  return (
    before?.kind === "column" &&
    after?.kind === "column" &&
    before.payload.type !== after.payload.type
  );
}
