import { quoteIdentifier } from "../../runtime/internal/index.ts";
import { childrenOf, namesOf, parentOf, type Catalog, type Fact } from "../catalog/index.ts";

type ActionKind =
  | "create schema"
  | "create table"
  | "add column"
  | "drop default"
  | "drop identity"
  | "set not null"
  | "drop not null"
  | "set default"
  | "add identity";

/** `fact` is what the action creates or changes: a schema, table, column, default, or identity. */
type Action = {
  readonly kind: ActionKind;
  readonly fact: Fact;
};

/**
 * Postgres refuses to add an identity to a column that has a default or isn't NOT NULL, and to
 * drop NOT NULL from an identity column, so each drop runs before the sets it would block.
 */
const PHASE: Readonly<Record<ActionKind, number>> = {
  "create schema": 0,
  "create table": 1,
  "add column": 2,
  "drop default": 3,
  "drop identity": 4,
  "set not null": 5,
  "drop not null": 5,
  "set default": 6,
  "add identity": 7,
};

/** What a fact adds when its column or table already exists. */
const ADDED = {
  column: "add column",
  default: "set default",
  identity: "add identity",
} as const;

/** The SQL that turns a database with catalog `from` into one with catalog `to`. */
export function diff(from: Catalog, to: Catalog): string {
  const actions: Action[] = [];
  for (const [key, fact] of from) {
    if (to.has(key)) continue;
    // A dropped column's default and identity go with it, and the column's own drop is refused first.
    if (fact.kind === "default") actions.push({ kind: "drop default", fact });
    else if (fact.kind === "identity") actions.push({ kind: "drop identity", fact });
    else throw new Error(`Can't drop ${fact.kind} ${qualified(fact, from)} yet`);
  }

  for (const [key, fact] of to) {
    const before = from.get(key);
    if (before !== undefined) actions.push(...alterations(before, fact, to));
    else if (fact.kind === "schema") actions.push({ kind: "create schema", fact });
    else if (fact.kind === "table") actions.push({ kind: "create table", fact });
    // A new table or column creates its children inline.
    else if (from.has(fact.parent)) actions.push({ kind: ADDED[fact.kind], fact });
  }

  return order(actions)
    .map((action) => `${render(action, to)}\n`)
    .join("\n");
}

function alterations(before: Fact, after: Fact, to: Catalog): Action[] {
  if (after.kind === "column" && before.kind === "column") {
    if (before.payload.type !== after.payload.type) {
      throw new Error(`Can't alter ${after.kind} ${qualified(after, to)} yet`);
    }
    if (before.payload.notNull === after.payload.notNull) return [];
    return [{ kind: after.payload.notNull ? "set not null" : "drop not null", fact: after }];
  }
  if (equal(before.payload, after.payload)) return [];
  if (after.kind === "default") return [{ kind: "set default", fact: after }];
  if (after.kind === "identity") {
    throw new Error(`Can't alter identity of column ${qualified(parentOf(to, after), to)} yet`);
  }
  throw new Error(`Can't alter ${after.kind} ${qualified(after, to)} yet`);
}

function order(actions: readonly Action[]): Action[] {
  // Stable, so ties keep the target catalog's order: Postgres can't reorder columns later.
  return actions.toSorted((a, b) => PHASE[a.kind] - PHASE[b.kind]);
}

function render({ kind, fact }: Action, to: Catalog): string {
  if (kind === "create schema") return `create schema ${quoteIdentifier(fact.name)};`;
  if (kind === "create table") {
    const columns = childrenOf(to, fact)
      .filter((child) => child.kind === "column")
      .map((child) => `  ${columnDefinition(child, to)}`);
    const body = columns.length === 0 ? "()" : `(\n${columns.join(",\n")}\n)`;
    return `create table ${qualified(fact, to)} ${body};`;
  }
  if (kind === "add column") {
    const table = qualified(parentOf(to, fact), to);
    return `alter table ${table} add column ${columnDefinition(fact, to)};`;
  }

  const column = fact.kind === "column" ? fact : parentOf(to, fact);
  const table = qualified(parentOf(to, column), to);
  const alter = `alter table ${table} alter column ${quoteIdentifier(column.name)}`;
  if (kind === "set not null") return `${alter} set not null;`;
  if (kind === "drop not null") return `${alter} drop not null;`;
  if (kind === "drop default") return `${alter} drop default;`;
  if (kind === "drop identity") return `${alter} drop identity;`;
  if (kind === "set default") return `${alter} set default ${defaultClause(fact)};`;
  return `${alter} add ${identityClause(fact)};`;
}

function columnDefinition(fact: Fact, to: Catalog): string {
  if (fact.kind !== "column") throw new Error(`${fact.kind} ${fact.name} isn't a column`);
  const { type, notNull } = fact.payload;
  const parts = [quoteIdentifier(fact.name), type];
  if (notNull) parts.push("not null");
  for (const child of childrenOf(to, fact)) {
    if (child.kind === "identity") parts.push(identityClause(child));
    if (child.kind === "default") parts.push(`default ${defaultClause(child)}`);
  }
  return parts.join(" ");
}

function identityClause(fact: Fact): string {
  if (fact.kind !== "identity") throw new Error(`${fact.kind} ${fact.name} isn't an identity`);
  return `generated ${fact.payload.generated} as identity`;
}

/** Parenthesized, so any expression the Definition writes parses as a default. */
function defaultClause(fact: Fact): string {
  if (fact.kind !== "default") throw new Error(`${fact.kind} ${fact.name} isn't a default`);
  return `(${fact.payload.expression})`;
}

function qualified(fact: Fact, catalog: Catalog): string {
  return namesOf(catalog, fact)
    .map((name) => quoteIdentifier(name))
    .join(".");
}

function equal(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const aEntries = Object.entries(a);
  const bValues = new Map(Object.entries(b));
  return (
    aEntries.length === bValues.size &&
    aEntries.every(([key, value]) => bValues.has(key) && equal(value, bValues.get(key)))
  );
}
