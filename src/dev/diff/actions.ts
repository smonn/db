import { quoteIdentifier } from "../../runtime/internal/index.ts";
import {
  childrenOf,
  qualified,
  type Catalog,
  type ColumnRename,
  type TableRename,
} from "../catalog/index.ts";
import { enumTypes, labelPosition, quoteLiteral } from "./enums.ts";
import {
  HAZARD_KINDS,
  LONG_LOCK,
  REWRITE,
  WRITE_LOCK,
  retypeHazards,
  type HazardKind,
} from "./hazards.ts";
import { renameSql } from "./rename-sql.ts";
import {
  addConstraint,
  alterColumn,
  alterTable,
  columnDefinition,
  columnList,
  defaultClause,
  identityClause,
  type FactOf,
} from "./statements.ts";

/** The kind of fact each action acts on. */
type Target = {
  "rename table": "table";
  "rename column": "column";
  "drop foreign key": "foreign key";
  "drop unique": "unique";
  "drop primary key": "primary key";
  "drop column": "column";
  "drop table": "table";
  "drop schema": "schema";
  "create schema": "schema";
  "create enum": "enum";
  "add enum value": "enum";
  "drop enum": "enum";
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
  /** The renamed object's fact is the `from` catalog's, which already holds the renamed object. */
  "rename table": { readonly rename: TableRename };
  "rename column": { readonly rename: ColumnRename };
  /** The enum as the `from` catalog has it, and the label to add to it. */
  "add enum value": { readonly before: FactOf<"enum">; readonly label: string };
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
  /** Most steps read only their fact; a step that also needs what its action carries takes the action. */
  readonly render: (fact: FactOf<Target[A]>, catalogs: Catalogs, action: Action<A>) => string;
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
  // Only the catalog changes, but app code on the old name breaks until it deploys (ADR-0024).
  "rename table": { render: renameStatement, hazards: always("rename") },
  "rename column": { render: renameStatement, hazards: always("rename") },
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
  "create enum": {
    render: (type, { to }) =>
      `create type ${qualified(type, to)} as enum (${type.payload.labels.map(quoteLiteral).join(", ")});`,
    hazards: none,
  },
  // Adding a label rewrites no row. Using it in the same transaction fails (55P04), which
  // `explainShadowError` words.
  "add enum value": {
    render: (fact, { to }, { before, label }) =>
      `alter type ${qualified(fact, to)} add value ${quoteLiteral(label)}${labelPosition(fact, before, label)};`,
    hazards: none,
  },
  "drop enum": {
    render: (type, { from }) => `drop type ${qualified(type, from)};`,
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
    hazards: ({ before, fact }, catalogs) =>
      retypeHazards(before.payload.type, fact.payload.type, enumTypes(catalogs.from, catalogs.to)),
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
    render: (key, { to }) => addConstraint(key, "unique", key.payload.columns, to),
    hazards: indexBuild,
  },
  "add foreign key": {
    render: addForeignKey,
    // A table created in the same migration is empty, so only an existing table has rows to scan.
    hazards: ({ fact }, { from }) => (from.has(fact.parent) ? WRITE_LOCK : []),
  },
};

export function render<A extends ActionKind>(action: Action<A>, catalogs: Catalogs): string {
  return STEPS[action.kind].render(action.fact, catalogs, action);
}

function renameStatement(
  _fact: unknown,
  _catalogs: Catalogs,
  { rename }: Action<"rename table" | "rename column">,
): string {
  return renameSql(rename);
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

function dropConstraint(
  key: FactOf<"primary key" | "unique" | "foreign key">,
  { from }: Catalogs,
): string {
  return `${alterTable(key, from)} drop constraint ${quoteIdentifier(key.name)};`;
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
