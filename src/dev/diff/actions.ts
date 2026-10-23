import { quoteIdentifier } from "../../runtime/internal/index.ts";
import { childrenOf, namesOf, parentOf, type Catalog, type Fact } from "../catalog/index.ts";
import { HAZARD_KINDS, LONG_LOCK, REWRITE, retypeHazards, type HazardKind } from "./hazards.ts";

type FactOf<K extends Fact["kind"]> = Extract<Fact, { readonly kind: K }>;

/** The kind of fact each action acts on. */
type Target = {
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
  "alter type": "column";
  "set not null": "column";
  "drop not null": "column";
  "set default": "default";
  "add identity": "identity";
  "add primary key": "primary key";
  "add unique": "unique";
};

type ActionKind = keyof Target;

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
  readonly phase: number;
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
 * Every action kind, with the phase `order` sorts it into and the SQL it renders.
 *
 * Postgres refuses to add an identity to a column that has a default or isn't NOT NULL, to drop
 * NOT NULL from an identity column, and to retype a column whose default can't be cast, so each
 * drop runs before the changes it would block. Keys drop first and add last, so a changed key is
 * rebuilt around the column changes it spans.
 *
 * Each kind also declares its Hazards, so a new kind can't compile without a decision. A table
 * created in the same migration is empty, so only changes to a table `from` has can be slow.
 */
const STEPS: { readonly [A in ActionKind]: Step<A> } = {
  "drop unique": { phase: 0, render: dropConstraint, hazards: none },
  "drop primary key": { phase: 1, render: dropConstraint, hazards: none },
  "drop column": {
    phase: 2,
    render: (column, { from }) =>
      `${alterTable(column, from)} drop column ${quoteIdentifier(column.name)};`,
    hazards: always("data_loss"),
  },
  "drop table": {
    phase: 3,
    render: (table, { from }) => `drop table ${qualified(table, from)};`,
    hazards: always("data_loss"),
  },
  "drop schema": {
    phase: 4,
    render: (schema) => `drop schema ${quoteIdentifier(schema.name)};`,
    hazards: none,
  },
  "create schema": {
    phase: 5,
    render: (schema) => `create schema ${quoteIdentifier(schema.name)};`,
    hazards: none,
  },
  "create table": { phase: 6, render: createTable, hazards: none },
  "add column": {
    phase: 7,
    render: (column, { to }) =>
      `${alterTable(column, to)} add column ${columnDefinition(column, to)};`,
    // An identity fills each row from its sequence, as a volatile default does.
    hazards: ({ fact }, { to }) =>
      childrenOf(to, fact).some(
        (child) =>
          child.kind === "identity" || (child.kind === "default" && child.payload.volatile),
      )
        ? REWRITE
        : [],
  },
  "drop default": {
    phase: 8,
    render: (fact, { from }) => `${alterColumn(fact, from)} drop default;`,
    hazards: none,
  },
  "drop identity": {
    phase: 9,
    render: (fact, { from }) => `${alterColumn(fact, from)} drop identity;`,
    hazards: none,
  },
  "alter type": {
    phase: 10,
    render: (column, { to }) => `${alterColumn(column, to)} type ${column.payload.type};`,
    hazards: ({ before, fact }) => retypeHazards(before.payload.type, fact.payload.type),
  },
  // Reads every row under the lock to prove none is null.
  "set not null": {
    phase: 11,
    render: (column, { to }) => `${alterColumn(column, to)} set not null;`,
    hazards: always(...LONG_LOCK),
  },
  "drop not null": {
    phase: 11,
    render: (column, { to }) => `${alterColumn(column, to)} drop not null;`,
    hazards: none,
  },
  "set default": {
    phase: 12,
    render: (fact, { to }) => `${alterColumn(fact, to)} set default ${defaultClause(fact)};`,
    hazards: none,
  },
  "add identity": {
    phase: 13,
    render: (fact, { to }) => `${alterColumn(fact, to)} add ${identityClause(fact)};`,
    hazards: none,
  },
  "add primary key": {
    phase: 14,
    render: (key, { to }) => addConstraint(key, "primary key", key.payload.columns, to),
    hazards: indexBuild,
  },
  "add unique": {
    phase: 15,
    render: (key, { to }) => addConstraint(key, "unique", [key.payload.column], to),
    hazards: indexBuild,
  },
};

/**
 * Sorts by phase. The sort is stable, so ties keep catalog order, which `introspect` sorts by name
 * for schemas, tables, and constraints and by position for columns, so new columns follow the
 * Definition. Drops keep the `from` catalog's order and everything else the `to` catalog's.
 */
export function order(actions: readonly Action[]): Action[] {
  return actions.toSorted((a, b) => STEPS[a.kind].phase - STEPS[b.kind].phase);
}

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

export function qualified(fact: Fact, catalog: Catalog): string {
  return namesOf(catalog, fact)
    .map((name) => quoteIdentifier(name))
    .join(".");
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
  }
  return parts.join(" ");
}

function dropConstraint(key: FactOf<"primary key" | "unique">, { from }: Catalogs): string {
  return `${alterTable(key, from)} drop constraint ${quoteIdentifier(key.name)};`;
}

function addConstraint(
  key: FactOf<"primary key" | "unique">,
  clause: string,
  columns: readonly string[],
  to: Catalog,
): string {
  const list = columns.map((column) => quoteIdentifier(column)).join(", ");
  return `${alterTable(key, to)} add constraint ${quoteIdentifier(key.name)} ${clause} (${list});`;
}

/** `alter table` for the table that holds `fact`, a column or key. */
function alterTable(fact: Fact, catalog: Catalog): string {
  return `alter table ${qualified(parentOf(catalog, fact), catalog)}`;
}

/** `alter column` for `fact`, a column or one of its attributes. */
function alterColumn(fact: FactOf<"column" | "default" | "identity">, catalog: Catalog): string {
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
