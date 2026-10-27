import {
  arePayloadsEqual,
  plainKeyColumns,
  type Catalog,
  type Fact,
  type Key,
  type Rename,
} from "../catalog/index.ts";
import type { Action, Catalogs } from "./actions.ts";
import { emit, type Diff } from "./emit.ts";
import { swapOf } from "./enum-swap.ts";
import type { Handling, HandlingTable } from "./handling.ts";
import { renameHints } from "./hints.ts";
import { foreignKeysAround, rebuiltColumns, retyped, without } from "./rebuilt.ts";
import { renameAction, renameByPayload } from "./renames.ts";
import { replacedTypes, TYPE_HANDLING } from "./type-handling.ts";

/**
 * The SQL that turns a database with catalog `from` into one with catalog `to`. With `renames`,
 * `from` is the catalog after those renames ran, and the SQL opens with them.
 */
export function diff(from: Catalog, to: Catalog, renames: readonly Rename[] = []): Diff {
  const catalogs = { from, to };
  // A column Postgres can't convert in place drops and adds back, so each side sees it, what it
  // holds, and the keys on it as absent from the other.
  const rebuilt = rebuiltColumns(catalogs);
  // A name that changes kind (a table for an enum) drops the old fact whole and creates the new
  // one whole, so neither side sees what the other holds under that name.
  const switched = kindSwitches(catalogs);
  const keptFrom = withoutSwitched(without(from, rebuilt, columnsNamedBy), switched);
  const keptTo = withoutSwitched(without(to, rebuilt, columnsNamedBy), switched);
  const tableTypes = replacedTypes(catalogs);
  const actions = renames.map((rename) => renameAction(rename, from));
  for (const [key, fact] of from) {
    const old = tableTypes.get(key);
    actions.push(
      ...(old === undefined
        ? sourceActions(fact, keptTo.get(key), keptTo, catalogs)
        : ([
            { kind: "rename replaced type", fact: old.type, aside: old.aside },
            { kind: "drop replaced type", fact: old.type, aside: old.aside },
          ] satisfies Action[])),
    );
  }
  for (const [key, fact] of to) {
    const before = keptFrom.get(key);
    actions.push(
      ...(before === undefined ? created(fact, keptFrom) : altered(before, fact, catalogs)),
    );
  }
  return {
    ...emit(foreignKeysAround(renameByPayload(actions), catalogs), catalogs),
    hints: renameHints(from, to),
  };
}

/** The keys at which the two catalogs hold different kinds of fact. */
function kindSwitches({ from, to }: Catalogs): ReadonlySet<Key> {
  return new Set(
    [...from].filter(([key, fact]) => to.get(key)?.kind !== fact.kind).map(([key]) => key),
  );
}

/** `catalog` without the facts at `switched`; the facts under them see their parent as absent. */
function withoutSwitched(catalog: Catalog, switched: ReadonlySet<Key>): Catalog {
  return new Map([...catalog].filter(([key]) => !switched.has(key)));
}

/** What the source pass does with one fact of `from`, given its counterpart `after` in `keptTo`. */
function sourceActions(
  fact: Fact,
  after: Fact | undefined,
  keptTo: Catalog,
  catalogs: Catalogs,
): Action[] {
  // A fact whose kind switched is absent from `keptTo`. Some can't change payload in place either:
  // the old one drops here, and `altered` adds the new one.
  if (after === undefined || replaced(fact, after)) return dropped(fact, keptTo);
  // Postgres refuses to retype a column whose default can't be cast, so it goes first.
  if (fact.kind === "default" && retyped(fact.parent, catalogs)) {
    return [{ kind: "drop default", fact }];
  }
  return [];
}

type Kind = Fact["kind"];
type FactOf<K extends Kind> = Extract<Fact, { readonly kind: K }>;

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
  ...TYPE_HANDLING,
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
    alter: (before, after, catalogs) => {
      const actions: Action[] = [];
      if (before.payload.type === after.payload.type) {
        const swap = swapOf(after.payload.type, catalogs);
        if (swap !== undefined) actions.push({ kind: "swap retype", fact: after, swap });
      } else {
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
    alter: (before, after) => {
      const actions: Action[] = [];
      if (before.payload.generated !== after.payload.generated) {
        actions.push({ kind: "set identity mode", fact: after });
      }
      // A table or column rename leaves the sequence under its old name.
      if (before.payload.sequence !== after.payload.sequence) {
        actions.push({ kind: "rename sequence", fact: after, was: before.payload.sequence });
      }
      return actions;
    },
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
    columnsNamed: (fact) => fact.payload.columns,
  },
  index: {
    parentDropCovers: true,
    drop: (fact) => [{ kind: "drop index", fact }],
    parentCreateCovers: false,
    create: (fact) => [{ kind: "add index", fact }],
    // No ALTER INDEX changes a key, the method, INCLUDE, or uniqueness.
    replacedOnChange: true,
    alter: () => [],
    columnsNamed: ({ payload }) => [...plainKeyColumns(payload.keys), ...payload.include],
  },
  "foreign key": {
    // Its target may drop before the table it sits on, and Postgres refuses to drop a key a
    // foreign key still needs, so every foreign key gets its own `DROP CONSTRAINT`.
    parentDropCovers: false,
    drop: (fact) => [{ kind: "drop foreign key", fact }],
    parentCreateCovers: false,
    create: (fact) => [{ kind: "add foreign key", fact }],
    replacedOnChange: true,
    alter: () => [],
    columnsNamed: (fact) => fact.payload.columns,
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

/**
 * Whether `catalog` lacks the parent of `fact`: the parent was dropped, or is new. Only a kind
 * with a parent asks, since the others never have their drop or create covered.
 */
function parentAbsent(fact: Fact, catalog: ReadonlyMap<Key | undefined, Fact>): boolean {
  return !catalog.has(fact.parent);
}

function altered(before: Fact, after: Fact, catalogs: Catalogs): Action[] {
  // The source pass dropped the old fact, so the new one is created whole.
  if (replaced(before, after)) return created(after, catalogs.from);
  return handlingOf(before).alter(before, after, catalogs);
}

/** Whether the fact at one key changed a payload its kind can't alter. */
function replaced(before: Fact, after: Fact): boolean {
  return handlingOf(before).replacedOnChange && !arePayloadsEqual(before.payload, after.payload);
}

function columnsNamedBy(fact: Fact): readonly string[] {
  return handlingOf(fact).columnsNamed(fact);
}
