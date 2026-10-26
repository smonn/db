import { quoteIdentifier } from "../../runtime/internal/index.ts";
import { childrenOf, parentOf, qualified, type Catalog, type Fact } from "../catalog/index.ts";
import {
  HAZARD_KINDS,
  LONG_LOCK,
  REWRITE,
  WRITE_LOCK,
  retypeHazards,
  type HazardKind,
} from "./hazards.ts";

type FactOf<K extends Fact["kind"]> = Extract<Fact, { readonly kind: K }>;

/** The kind of fact each action acts on. */
type Target = {
  "drop foreign key": "foreign key";
  "drop unique": "unique";
  "drop primary key": "primary key";
  "drop column": "column";
  "drop table": "table";
  "drop schema": "schema";
  "create schema": "schema";
  "create table": "table";
  "add column": "column";
  "drop default": "default";
  "drop identity": "identity";
  "drop expression": "generated";
  "alter type": "column";
  "set not null": "column";
  "drop not null": "column";
  "set default": "default";
  "add identity": "identity";
  "set identity mode": "identity";
  "set expression": "generated";
  "add primary key": "primary key";
  "add unique": "unique";
  "add foreign key": "foreign key";
};

export type ActionKind = keyof Target;

/** What an action needs beyond its fact. */
type Carries = {
  /** The column as the `from` catalog has it, since a type change's hazards depend on both types. */
  "alter type": { readonly before: FactOf<"column"> };
};

/**
 * One statement-sized change. A drop's fact comes from the `from` catalog, and every other
 * action's from `to`.
 */
export type Action<A extends ActionKind = ActionKind> = {
  [K in A]: { readonly kind: K; readonly fact: FactOf<Target[K]> } & (K extends keyof Carries
    ? Carries[K]
    : unknown);
}[A];

export type Catalogs = { readonly from: Catalog; readonly to: Catalog };

type Step<A extends ActionKind> = {
  readonly render: (fact: FactOf<Target[A]>, catalogs: Catalogs) => string;
  /** Classified from the catalogs the action reads, never from the SQL it renders. */
  readonly hazards: (action: Action<A>, catalogs: Catalogs) => readonly HazardKind[];
};

const none = (): readonly HazardKind[] => [];
const always =
  (...kinds: readonly HazardKind[]) =>
  (): readonly HazardKind[] =>
    kinds;

/**
 * Every action kind, with the SQL it renders.
 *
 * Each kind also declares its Hazards, so a new kind can't compile without a decision. A table
 * created in the same migration is empty, so only changes to a table `from` has can be slow.
 */
const STEPS: { readonly [A in ActionKind]: Step<A> } = {
  "drop foreign key": { render: dropConstraint, hazards: none },
  "drop unique": { render: dropConstraint, hazards: none },
  "drop primary key": { render: dropConstraint, hazards: none },
  "drop column": {
    render: (column, { from }) =>
      `${alterTable(column, from)} drop column ${quoteIdentifier(column.name)};`,
    hazards: always("data_loss"),
  },
  "drop table": {
    render: (table, { from }) => `drop table ${qualified(table, from)};`,
    hazards: always("data_loss"),
  },
  "drop schema": {
    render: (schema) => `drop schema ${quoteIdentifier(schema.name)};`,
    hazards: none,
  },
  "create schema": {
    render: (schema) => `create schema ${quoteIdentifier(schema.name)};`,
    hazards: none,
  },
  "create table": { render: createTable, hazards: none },
  "add column": {
    render: (column, { to }) =>
      `${alterTable(column, to)} add column ${columnDefinition(column, to)};`,
    // An identity fills each row from its sequence, as a volatile default does, and a stored
    // expression computes every row.
    hazards: ({ fact }, { to }) =>
      childrenOf(to, fact).some(
        (child) =>
          child.kind === "identity" ||
          (child.kind === "default" && child.payload.volatile) ||
          (child.kind === "generated" && child.payload.storage === "stored"),
      )
        ? REWRITE
        : [],
  },
  "drop default": {
    render: (fact, { from }) => `${alterColumn(fact, from)} drop default;`,
    hazards: none,
  },
  "drop identity": {
    render: (fact, { from }) => `${alterColumn(fact, from)} drop identity;`,
    hazards: none,
  },
  // Keeps the stored values, so the table is not rewritten.
  "drop expression": {
    render: (fact, { from }) => `${alterColumn(fact, from)} drop expression;`,
    hazards: none,
  },
  "alter type": {
    render: (column, { to }) => `${alterColumn(column, to)} type ${column.payload.type};`,
    hazards: ({ before, fact }) => retypeHazards(before.payload.type, fact.payload.type),
  },
  // Reads every row under the lock to prove none is null.
  "set not null": {
    render: (column, { to }) => `${alterColumn(column, to)} set not null;`,
    hazards: always(...LONG_LOCK),
  },
  "drop not null": {
    render: (column, { to }) => `${alterColumn(column, to)} drop not null;`,
    hazards: none,
  },
  "set default": {
    render: (fact, { to }) => `${alterColumn(fact, to)} set default ${defaultClause(fact)};`,
    hazards: none,
  },
  // Recomputes a stored column under the lock; a virtual one computes on read.
  "set expression": {
    render: (fact, { to }) =>
      `${alterColumn(fact, to)} set expression as (${fact.payload.expression});`,
    hazards: ({ fact }) => (fact.payload.storage === "stored" ? REWRITE : []),
  },
  "add identity": {
    render: (fact, { to }) => `${alterColumn(fact, to)} add ${identityClause(fact)};`,
    hazards: none,
  },
  "set identity mode": {
    render: (fact, { to }) => `${alterColumn(fact, to)} set generated ${fact.payload.generated};`,
    hazards: none,
  },
  "add primary key": {
    render: (key, { to }) => addConstraint(key, "primary key", key.payload.columns, to),
    hazards: indexBuild,
  },
  "add unique": {
    render: (key, { to }) => addConstraint(key, "unique", [key.payload.column], to),
    hazards: indexBuild,
  },
  "add foreign key": {
    render: addForeignKey,
    // A table created in the same migration is empty, so only an existing table has rows to scan.
    hazards: ({ fact }, { from }) => (from.has(fact.parent) ? WRITE_LOCK : []),
  },
};

export function render<A extends ActionKind>(action: Action<A>, catalogs: Catalogs): string {
  return STEPS[action.kind].render(action.fact, catalogs);
}

/** In `HAZARD_KINDS` order, so the `-- hazard:` comments above a statement always read alike. */
export function hazardsOf<A extends ActionKind>(
  action: Action<A>,
  catalogs: Catalogs,
): readonly HazardKind[] {
  const declared = STEPS[action.kind].hazards(action, catalogs);
  return HAZARD_KINDS.filter((kind) => declared.includes(kind));
}

/**
 * Building the index holds ACCESS EXCLUSIVE while it reads every row. A table created in the same
 * migration is empty, so only a table `from` already has pays for it.
 */
function indexBuild(
  { fact }: { readonly fact: FactOf<"primary key" | "unique"> },
  { from }: Catalogs,
): readonly HazardKind[] {
  return from.has(fact.parent) ? LONG_LOCK : [];
}

function createTable(table: FactOf<"table">, { to }: Catalogs): string {
  const columns = childrenOf(to, table).flatMap((child) =>
    child.kind === "column" ? [`  ${columnDefinition(child, to)}`] : [],
  );
  const body = columns.length === 0 ? "()" : `(\n${columns.join(",\n")}\n)`;
  return `create table ${qualified(table, to)} ${body};`;
}

function columnDefinition(column: FactOf<"column">, to: Catalog): string {
  const { type, notNull } = column.payload;
  const parts = [quoteIdentifier(column.name), type];
  if (notNull) parts.push("not null");
  for (const child of childrenOf(to, column)) {
    if (child.kind === "identity") parts.push(identityClause(child));
    if (child.kind === "default") parts.push(`default ${defaultClause(child)}`);
    if (child.kind === "generated") {
      parts.push(`generated always as (${child.payload.expression}) ${child.payload.storage}`);
    }
  }
  return parts.join(" ");
}

function dropConstraint(
  key: FactOf<"primary key" | "unique" | "foreign key">,
  { from }: Catalogs,
): string {
  return `${alterTable(key, from)} drop constraint ${quoteIdentifier(key.name)};`;
}

function addConstraint(
  key: FactOf<"primary key" | "unique">,
  clause: string,
  columns: readonly string[],
  to: Catalog,
): string {
  return `${alterTable(key, to)} add constraint ${quoteIdentifier(key.name)} ${clause} (${columnList(columns)});`;
}

function columnList(names: readonly string[]): string {
  return names.map((name) => quoteIdentifier(name)).join(", ");
}

/** Leaves out the clauses at Postgres's defaults, so the statement reads like the SQL one writes. */
function addForeignKey(key: FactOf<"foreign key">, { to }: Catalogs): string {
  const { columns, target, onDelete, onUpdate, match, deferrable } = key.payload;
  const clauses = [
    match === "full" ? "match full" : "",
    onDelete === "no action" ? "" : `on delete ${onDelete}`,
    onUpdate === "no action" ? "" : `on update ${onUpdate}`,
    deferrable === "not deferrable" ? "" : `deferrable initially ${deferrable}`,
  ].filter((clause) => clause !== "");
  const references = `${quoteIdentifier(target.schema)}.${quoteIdentifier(target.table)} (${columnList(target.columns)})`;
  return `${alterTable(key, to)} add constraint ${quoteIdentifier(key.name)} foreign key (${columnList(columns)}) references ${[references, ...clauses].join(" ")};`;
}

/** `alter table` for the table that holds `fact`, a column or key. */
function alterTable(fact: Fact, catalog: Catalog): string {
  return `alter table ${qualified(parentOf(catalog, fact), catalog)}`;
}

/** `alter column` for `fact`, a column or one of its attributes. */
function alterColumn(
  fact: FactOf<"column" | "default" | "identity" | "generated">,
  catalog: Catalog,
): string {
  const column = fact.kind === "column" ? fact : parentOf(catalog, fact);
  return `${alterTable(column, catalog)} alter column ${quoteIdentifier(column.name)}`;
}

function identityClause(identity: FactOf<"identity">): string {
  return `generated ${identity.payload.generated} as identity`;
}

/** Parenthesized, so any expression the Definition writes parses as a default. */
function defaultClause(fact: FactOf<"default">): string {
  return `(${fact.payload.expression})`;
}
