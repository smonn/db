import {
  arePayloadsEqual,
  childrenOf,
  factAt,
  type Catalog,
  type Fact,
  type GeneratedPayload,
  type Key,
  type Rename,
} from "../catalog/index.ts";
import { hazardsOf, render, type Action, type Catalogs } from "./actions.ts";
import type { Hazard } from "./hazards.ts";
import { renameHints } from "./hints.ts";
import { order } from "./phases.ts";

export type Diff = {
  /** Each statement follows one `-- hazard: <kind>` comment per Hazard it carries. */
  readonly sql: string;
  readonly hazards: readonly Hazard[];
  /** Renames the Definition could declare, for a drop and an add that look like one (ADR-0024). */
  readonly hints: readonly string[];
};

/**
 * The SQL that turns a database with catalog `from` into one with catalog `to`. With `renames`,
 * `from` is the catalog after those renames ran, and the SQL opens with them.
 */
export function diff(from: Catalog, to: Catalog, renames: readonly Rename[] = []): Diff {
  const catalogs = { from, to };
  // A column Postgres can't convert in place drops and adds back, so each side sees it, what it
  // holds, and the keys on it as absent from the other.
  const rebuilt = rebuiltColumns(catalogs);
  const keptFrom = without(from, rebuilt);
  const keptTo = without(to, rebuilt);
  const actions = renames.map((rename) => renameAction(rename, from));
  for (const [key, fact] of from) {
    const after = keptTo.get(key);
    if (after === undefined) actions.push(...dropped(fact, keptTo));
    // A fact can't change kind, nor can some change payload in place: the old one drops here,
    // and `altered` adds the new one.
    else if (replaced(fact, after)) actions.push(...dropped(fact, keptTo));
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
  return { sql, hazards, hints: renameHints(from, to) };
}

function renameAction(rename: Rename, from: Catalog): Action {
  const names =
    rename.kind === "table"
      ? [rename.schema, rename.name]
      : [rename.schema, rename.table, rename.name];
  const fact = factAt(from, ...names);
  if (rename.kind === "table" && fact?.kind === "table") {
    return { kind: "rename table", fact, rename };
  }
  if (rename.kind === "column" && fact?.kind === "column") {
    return { kind: "rename column", fact, rename };
  }
  throw new Error(`the renamed ${rename.kind} ${names.join(".")} isn't in the catalog`);
}

type Kind = Fact["kind"];
type FactOf<K extends Kind> = Extract<Fact, { readonly kind: K }>;

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
  /** Whether a changed payload drops the fact and creates it again, rather than altering it. */
  readonly replacedOnChange: boolean;
  /** Compares two facts of this kind at one key that the source pass didn't replace. */
  readonly alter: (before: F, after: F, catalogs: Catalogs) => Action[];
  /** The columns of its parent table the fact names, so a rebuilt one drops and re-adds it. */
  readonly columnsNamed: (fact: F) => readonly string[];
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
    replacedOnChange: false,
    alter: () => [],
    columnsNamed: () => [],
  },
  table: {
    parentDropCovers: false,
    drop: (fact) => [{ kind: "drop table", fact }],
    parentCreateCovers: false,
    create: (fact) => [{ kind: "create table", fact }],
    replacedOnChange: false,
    alter: () => [],
    columnsNamed: () => [],
  },
  column: {
    parentDropCovers: true,
    drop: (fact) => [{ kind: "drop column", fact }],
    parentCreateCovers: true,
    create: (fact) => [{ kind: "add column", fact }],
    replacedOnChange: false,
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
    columnsNamed: () => [],
  },
  default: {
    parentDropCovers: true,
    drop: (fact) => [{ kind: "drop default", fact }],
    parentCreateCovers: true,
    create: (fact) => [{ kind: "set default", fact }],
    replacedOnChange: false,
    alter: (before, after, catalogs) =>
      // A retyped column's default was dropped first, whether or not it changed.
      arePayloadsEqual(before.payload, after.payload) && !retyped(after.parent, catalogs)
        ? []
        : [{ kind: "set default", fact: after }],
    columnsNamed: () => [],
  },
  identity: {
    parentDropCovers: true,
    drop: (fact) => [{ kind: "drop identity", fact }],
    parentCreateCovers: true,
    create: (fact) => [{ kind: "add identity", fact }],
    replacedOnChange: false,
    alter: (before, after) =>
      arePayloadsEqual(before.payload, after.payload)
        ? []
        : [{ kind: "set identity mode", fact: after }],
    columnsNamed: () => [],
  },
  generated: {
    parentDropCovers: true,
    // Only a stored column converts in place; `rebuiltColumns` sends the rest to `drop column`.
    drop: (fact) => [{ kind: "drop expression", fact }],
    parentCreateCovers: true,
    // Postgres can't make a plain column generated, so a new expression is on a rebuilt column,
    // which `add column` renders whole.
    create: () => [],
    replacedOnChange: false,
    alter: (before, after) =>
      arePayloadsEqual(before.payload, after.payload)
        ? []
        : [{ kind: "set expression", fact: after }],
    columnsNamed: () => [],
  },
  "primary key": {
    parentDropCovers: true,
    drop: (fact) => [{ kind: "drop primary key", fact }],
    // Never inline: CREATE TABLE silently drops a unique that duplicates the primary key.
    parentCreateCovers: false,
    create: (fact) => [{ kind: "add primary key", fact }],
    // A key can't change in place.
    replacedOnChange: true,
    alter: () => [],
    columnsNamed: (fact) => fact.payload.columns,
  },
  unique: {
    parentDropCovers: true,
    drop: (fact) => [{ kind: "drop unique", fact }],
    parentCreateCovers: false,
    create: (fact) => [{ kind: "add unique", fact }],
    replacedOnChange: true,
    alter: () => [],
    columnsNamed: (fact) => [fact.payload.column],
  },
};

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
  // The source pass dropped the old fact, so the new one is created whole.
  if (replaced(before, after)) return created(after, catalogs.from);
  return handlingOf(before).alter(before, after, catalogs);
}

/** Whether the fact at one key changed kind, or changed a payload its kind can't alter. */
function replaced(before: Fact, after: Fact): boolean {
  return (
    before.kind !== after.kind ||
    (handlingOf(before).replacedOnChange && !arePayloadsEqual(before.payload, after.payload))
  );
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

/** `catalog` without the rebuilt columns, the facts under them, and the facts that name them. */
function without(catalog: Catalog, rebuilt: ReadonlyMap<Key, Fact>): Catalog {
  const columns = [...rebuilt.values()];
  return new Map(
    [...catalog].filter(
      ([key, fact]) =>
        !rebuilt.has(key) &&
        !(fact.parent !== undefined && rebuilt.has(fact.parent)) &&
        !columns.some(
          (column) =>
            column.parent === fact.parent &&
            handlingOf(fact).columnsNamed(fact).includes(column.name),
        ),
    ),
  );
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
