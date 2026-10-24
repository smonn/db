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

/**
 * Dropping a table or column drops what it holds, so its children emit nothing. A schema drop
 * without CASCADE refuses to drop what it holds, so its tables drop on their own first.
 */
function dropped(fact: Fact, to: Catalog): Action[] {
  if (fact.kind === "schema") return [{ kind: "drop schema", fact }];
  if (fact.kind === "table") return [{ kind: "drop table", fact }];
  if (!to.has(fact.parent)) return [];
  if (fact.kind === "column") return [{ kind: "drop column", fact }];
  if (fact.kind === "default") return [{ kind: "drop default", fact }];
  if (fact.kind === "identity") return [{ kind: "drop identity", fact }];
  // Only a stored column converts in place; `rebuiltColumns` sends the rest to `drop column`.
  if (fact.kind === "generated") return [{ kind: "drop expression", fact }];
  if (fact.kind === "primary key") return [{ kind: "drop primary key", fact }];
  if (fact.kind === "unique") return [{ kind: "drop unique", fact }];
  return unhandled(fact);
}

function created(fact: Fact, from: Catalog): Action[] {
  if (fact.kind === "schema") return [{ kind: "create schema", fact }];
  if (fact.kind === "table") return [{ kind: "create table", fact }];
  // Never inline: CREATE TABLE silently drops a unique that duplicates the primary key.
  if (fact.kind === "primary key") return [{ kind: "add primary key", fact }];
  if (fact.kind === "unique") return [{ kind: "add unique", fact }];
  // Postgres can't make a plain column generated, so a new expression is on a rebuilt column,
  // which `add column` renders whole.
  if (fact.kind === "generated") return [];
  // A new table or column creates its other children inline.
  if (!from.has(fact.parent)) return [];
  if (fact.kind === "column") return [{ kind: "add column", fact }];
  if (fact.kind === "default") return [{ kind: "set default", fact }];
  if (fact.kind === "identity") return [{ kind: "add identity", fact }];
  return unhandled(fact);
}

function altered(before: Fact, after: Fact, catalogs: Catalogs): Action[] {
  // The old kind was dropped in the source pass, whatever the payloads say.
  if (before.kind !== after.kind) return created(after, catalogs.from);
  if (before.kind === "column" && after.kind === "column") {
    const actions: Action[] = [];
    if (before.payload.type !== after.payload.type) {
      actions.push({ kind: "alter type", fact: after, before });
    }
    if (before.payload.notNull !== after.payload.notNull) {
      actions.push({ kind: after.payload.notNull ? "set not null" : "drop not null", fact: after });
    }
    return actions;
  }
  if (before.kind === "default" && after.kind === "default") {
    // A retyped column's default was dropped first, whether or not it changed.
    if (arePayloadsEqual(before.payload, after.payload) && !retyped(after.parent, catalogs))
      return [];
    return [{ kind: "set default", fact: after }];
  }
  if (before.kind === "generated" && after.kind === "generated") {
    return arePayloadsEqual(before.payload, after.payload)
      ? []
      : [{ kind: "set expression", fact: after }];
  }
  if (before.kind === "identity" && after.kind === "identity") {
    return arePayloadsEqual(before.payload, after.payload)
      ? []
      : [{ kind: "set identity mode", fact: after }];
  }
  return alteredByPayload(before, after, catalogs);
}

/** The kinds with no in-place change: schemas and tables carry no payload, and a key re-adds. */
function alteredByPayload(before: Fact, after: Fact, { from }: Catalogs): Action[] {
  if (before.kind === "schema" || before.kind === "table") return [];
  if (!isKey(before) || !isKey(after)) {
    // A new kind needs its own comparison above; guessing from its payload could emit a duplicate.
    throw new Error(`Unhandled fact kind ${JSON.stringify(after.kind)}`);
  }
  // The old key was dropped in the source pass.
  return arePayloadsEqual(before.payload, after.payload) ? [] : created(after, from);
}

/** Compile-time proof that every kind has an action; at run time, a kind this diff predates. */
function unhandled(fact: never): never {
  throw new Error(`Unhandled fact kind ${JSON.stringify((fact as Fact).kind)}`);
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
