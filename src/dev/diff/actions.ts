import { quoteIdentifier } from "../../runtime/internal/index.ts";
import { qualified, type Catalog, type ColumnRename, type TableRename } from "../catalog/index.ts";
import { columnRetypeHazards, fillsEachRow } from "./column-hazards.ts";
import { SWAP_STEPS, type Swap } from "./enum-swap.ts";
import {
  HAZARD_KINDS,
  INDEX_LOCK,
  LONG_LOCK,
  REWRITE,
  WRITE_LOCK,
  type HazardKind,
} from "./hazards.ts";
import { renameSql } from "./rename-sql.ts";
import { TYPE_STEPS, type TypeTarget } from "./type-steps.ts";
import { createIndex, dropIndex } from "./index-statements.ts";
import {
  addConstraint,
  addForeignKey,
  alterColumn,
  alterTable,
  columnDefinition,
  createTable,
  defaultClause,
  dropConstraint,
  identityClause,
  type FactOf,
} from "./statements.ts";

/** The kind of fact each action acts on. */
type Target = TypeTarget & {
  "rename table": "table";
  "rename column": "column";
  "drop foreign key": "foreign key";
  "drop unique": "unique";
  "drop index": "index";
  "drop primary key": "primary key";
  "drop column": "column";
  "drop table": "table";
  "drop schema": "schema";
  "create schema": "schema";
  "rename enum aside": "enum";
  "drop enum aside": "enum";
  "swap retype": "column";
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
  "add index": "index";
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
  "rename enum aside": { readonly swap: Swap };
  "drop enum aside": { readonly swap: Swap };
  "swap retype": { readonly swap: Swap };
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
  // Only the catalog changes, like dropping a key.
  "drop index": { render: dropIndex, hazards: none },
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
  ...TYPE_STEPS,
  ...SWAP_STEPS,
  "create table": { render: createTable, hazards: none },
  "add column": {
    render: (column, { to }) =>
      `${alterTable(column, to)} add column ${columnDefinition(column, to)};`,
    hazards: ({ fact }, { to }) => (fillsEachRow(fact, to) ? REWRITE : []),
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
    hazards: ({ before, fact }, catalogs) => columnRetypeHazards(before, fact, catalogs),
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
    render: (key, { to }) =>
      addConstraint(
        key,
        key.payload.nullsNotDistinct ? "unique nulls not distinct" : "unique",
        key.payload.columns,
        to,
      ),
    hazards: indexBuild,
  },
  "add index": {
    render: (index, { to }) => createIndex(index, to),
    // A table created in the same migration is empty, so only an existing table has rows to read.
    hazards: ({ fact }, { from }) => (from.has(fact.parent) ? INDEX_LOCK : []),
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
