import { quoteIdentifier } from "../../runtime/internal/index.ts";
import { childrenOf, namesOf, parentOf, type Catalog, type Fact } from "../catalog/index.ts";

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

/**
 * One statement-sized change. A drop's fact comes from the `from` catalog, and every other
 * action's from `to`.
 */
export type Action<A extends ActionKind = ActionKind> = {
  [K in A]: { readonly kind: K; readonly fact: FactOf<Target[K]> };
}[A];

export type Catalogs = { readonly from: Catalog; readonly to: Catalog };

type Step<A extends ActionKind> = {
  readonly phase: number;
  readonly render: (fact: FactOf<Target[A]>, catalogs: Catalogs) => string;
};

/**
 * Every action kind, with the phase `order` sorts it into and the SQL it renders.
 *
 * Postgres refuses to add an identity to a column that has a default or isn't NOT NULL, to drop
 * NOT NULL from an identity column, and to retype a column whose default can't be cast, so each
 * drop runs before the changes it would block. Keys drop first and add last, so a changed key is
 * rebuilt around the column changes it spans.
 */
const STEPS: { readonly [A in ActionKind]: Step<A> } = {
  "drop unique": { phase: 0, render: dropConstraint },
  "drop primary key": { phase: 1, render: dropConstraint },
  "drop column": {
    phase: 2,
    render: (column, { from }) =>
      `${alterTable(column, from)} drop column ${quoteIdentifier(column.name)};`,
  },
  "drop table": { phase: 3, render: (table, { from }) => `drop table ${qualified(table, from)};` },
  "drop schema": { phase: 4, render: (schema) => `drop schema ${quoteIdentifier(schema.name)};` },
  "create schema": {
    phase: 5,
    render: (schema) => `create schema ${quoteIdentifier(schema.name)};`,
  },
  "create table": { phase: 6, render: createTable },
  "add column": {
    phase: 7,
    render: (column, { to }) =>
      `${alterTable(column, to)} add column ${columnDefinition(column, to)};`,
  },
  "drop default": {
    phase: 8,
    render: (fact, { from }) => `${alterColumn(fact, from)} drop default;`,
  },
  "drop identity": {
    phase: 9,
    render: (fact, { from }) => `${alterColumn(fact, from)} drop identity;`,
  },
  "alter type": {
    phase: 10,
    render: (column, { to }) => `${alterColumn(column, to)} type ${column.payload.type};`,
  },
  "set not null": {
    phase: 11,
    render: (column, { to }) => `${alterColumn(column, to)} set not null;`,
  },
  "drop not null": {
    phase: 11,
    render: (column, { to }) => `${alterColumn(column, to)} drop not null;`,
  },
  "set default": {
    phase: 12,
    render: (fact, { to }) => `${alterColumn(fact, to)} set default ${defaultClause(fact)};`,
  },
  "add identity": {
    phase: 13,
    render: (fact, { to }) => `${alterColumn(fact, to)} add ${identityClause(fact)};`,
  },
  "add primary key": {
    phase: 14,
    render: (key, { to }) => addConstraint(key, "primary key", key.payload.columns, to),
  },
  "add unique": {
    phase: 15,
    render: (key, { to }) => addConstraint(key, "unique", [key.payload.column], to),
  },
};

/**
 * Sorts by phase. The sort is stable, so ties keep the order `diff` finds them in: drops in the
 * `from` catalog's order, and everything else in the `to` catalog's, so new columns follow the
 * Definition, since Postgres can't reorder columns later.
 */
export function order(actions: readonly Action[]): Action[] {
  return actions.toSorted((a, b) => STEPS[a.kind].phase - STEPS[b.kind].phase);
}

export function render<A extends ActionKind>(action: Action<A>, catalogs: Catalogs): string {
  return STEPS[action.kind].render(action.fact, catalogs);
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
