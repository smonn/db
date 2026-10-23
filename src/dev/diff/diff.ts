import {
  parentOf,
  payloadsEqual,
  qualified,
  type Catalog,
  type Fact,
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
  const actions: Action[] = [];
  for (const [key, fact] of from) {
    const after = to.get(key);
    if (after === undefined) actions.push(...dropped(fact, to));
    // A key can't change in place: the old one drops here, and `altered` adds the new one.
    else if (isKey(fact) && !payloadsEqual(fact.payload, after.payload))
      actions.push(...dropped(fact, to));
    // Postgres refuses to retype a column whose default can't be cast, so it goes first.
    else if (fact.kind === "default" && retyped(fact.parent, catalogs)) {
      actions.push({ kind: "drop default", fact });
    }
  }
  for (const [key, fact] of to) {
    const before = from.get(key);
    actions.push(...(before === undefined ? created(fact, from) : altered(before, fact, catalogs)));
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
  if (fact.kind === "primary key") return [{ kind: "drop primary key", fact }];
  return [{ kind: "drop unique", fact }];
}

function created(fact: Fact, from: Catalog): Action[] {
  if (fact.kind === "schema") return [{ kind: "create schema", fact }];
  if (fact.kind === "table") return [{ kind: "create table", fact }];
  // Never inline: CREATE TABLE silently drops a unique that duplicates the primary key.
  if (fact.kind === "primary key") return [{ kind: "add primary key", fact }];
  if (fact.kind === "unique") return [{ kind: "add unique", fact }];
  // A new table or column creates its other children inline.
  if (!from.has(fact.parent)) return [];
  if (fact.kind === "column") return [{ kind: "add column", fact }];
  if (fact.kind === "default") return [{ kind: "set default", fact }];
  return [{ kind: "add identity", fact }];
}

function altered(before: Fact, after: Fact, catalogs: Catalogs): Action[] {
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
    if (payloadsEqual(before.payload, after.payload) && !retyped(after.parent, catalogs)) return [];
    return [{ kind: "set default", fact: after }];
  }
  if (payloadsEqual(before.payload, after.payload)) return [];
  // The old key was dropped in the source pass.
  if (before.kind === "primary key" && after.kind === "primary key") {
    return [{ kind: "add primary key", fact: after }];
  }
  if (before.kind === "unique" && after.kind === "unique") {
    return [{ kind: "add unique", fact: after }];
  }
  // Schemas and tables carry no payload, so only an identity is left.
  throw new Error(
    `Can't alter identity of column ${qualified(parentOf(catalogs.to, after), catalogs.to)} yet`,
  );
}

function isKey(fact: Fact): fact is Extract<Fact, { readonly kind: "primary key" | "unique" }> {
  return fact.kind === "primary key" || fact.kind === "unique";
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
