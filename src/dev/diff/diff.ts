import { quoteIdentifier } from "../../runtime/internal/index.ts";
import { childrenOf, namesOf, parentOf, type Catalog, type Fact } from "../catalog/index.ts";

type ActionKind =
  | "drop unique"
  | "drop primary key"
  | "create schema"
  | "create table"
  | "add column"
  | "drop default"
  | "drop identity"
  | "set not null"
  | "drop not null"
  | "set default"
  | "add identity"
  | "add primary key"
  | "add unique";

/** `fact` is what the action creates or changes: a schema, table, column, or one of their children. */
type Action = {
  readonly kind: ActionKind;
  readonly fact: Fact;
};

/**
 * Postgres refuses to add an identity to a column that has a default or isn't NOT NULL, and to
 * drop NOT NULL from an identity column, so each drop runs before the sets it would block. Keys
 * drop first and add last, so a changed key is rebuilt around the column changes it spans.
 */
const PHASE: Readonly<Record<ActionKind, number>> = {
  "drop unique": 0,
  "drop primary key": 1,
  "create schema": 2,
  "create table": 3,
  "add column": 4,
  "drop default": 5,
  "drop identity": 6,
  "set not null": 7,
  "drop not null": 7,
  "set default": 8,
  "add identity": 9,
  "add primary key": 10,
  "add unique": 11,
};

/** What a fact adds when its table or column exists; a key is added even to a new table. */
const ADDED = {
  column: "add column",
  default: "set default",
  identity: "add identity",
  "primary key": "add primary key",
  unique: "add unique",
} as const;

const DROPPED = {
  default: "drop default",
  identity: "drop identity",
  "primary key": "drop primary key",
  unique: "drop unique",
} as const;

/** The SQL that turns a database with catalog `from` into one with catalog `to`. */
export function diff(from: Catalog, to: Catalog): string {
  const actions: Action[] = [];
  for (const [key, fact] of from) {
    if (to.has(key)) continue;
    // A dropped column's default and identity go with it, and the column's own drop is refused first.
    if (
      fact.kind === "default" ||
      fact.kind === "identity" ||
      fact.kind === "primary key" ||
      fact.kind === "unique"
    ) {
      actions.push({ kind: DROPPED[fact.kind], fact });
    } else throw new Error(`Can't drop ${fact.kind} ${qualified(fact, from)} yet`);
  }

  for (const [key, fact] of to) {
    const before = from.get(key);
    if (before !== undefined) actions.push(...alterations(before, fact, to));
    else if (fact.kind === "schema") actions.push({ kind: "create schema", fact });
    else if (fact.kind === "table") actions.push({ kind: "create table", fact });
    else if (fact.kind === "primary key" || fact.kind === "unique") {
      // Never inline: CREATE TABLE silently drops a unique that duplicates the primary key.
      actions.push({ kind: ADDED[fact.kind], fact });
    }
    // A new table or column creates its other children inline.
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
  // A key can't change in place; the drop runs in an earlier phase than the add.
  if (before.kind === "primary key" && after.kind === "primary key") {
    return [
      { kind: "drop primary key", fact: before },
      { kind: "add primary key", fact: after },
    ];
  }
  if (before.kind === "unique" && after.kind === "unique") {
    return [
      { kind: "drop unique", fact: before },
      { kind: "add unique", fact: after },
    ];
  }
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

  if (fact.kind === "primary key" || fact.kind === "unique") {
    const table = qualified(parentOf(to, fact), to);
    const alter = `alter table ${table}`;
    const name = quoteIdentifier(fact.name);
    if (kind === "drop primary key" || kind === "drop unique") {
      return `${alter} drop constraint ${name};`;
    }
    const { clause, columns } =
      fact.kind === "primary key"
        ? { clause: "primary key", columns: fact.payload.columns }
        : { clause: "unique", columns: [fact.payload.column] };
    const list = columns.map((column) => quoteIdentifier(column)).join(", ");
    return `${alter} add constraint ${name} ${clause} (${list});`;
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
