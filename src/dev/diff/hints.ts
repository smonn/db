import {
  childrenOf,
  factAt,
  namesOf,
  qualified,
  type Catalog,
  type Fact,
} from "../catalog/index.ts";

type FactOf<K extends Fact["kind"]> = Extract<Fact, { readonly kind: K }>;

/**
 * What to add to the Definition when a drop and an add look like a rename (ADR-0024): a table that
 * drops one column and adds one of the same type, or a schema that drops one table and adds one
 * with identical columns. A guess only prints; it never reaches the SQL.
 */
export function renameHints(from: Catalog, to: Catalog): string[] {
  const hints: string[] = [];
  for (const [key, fact] of to) hints.push(...hintsFor(from, to, from.get(key), fact));
  return hints;
}

function hintsFor(from: Catalog, to: Catalog, before: Fact | undefined, fact: Fact): string[] {
  if (fact.kind === "table") return columnHints(from, to, before, fact);
  if (fact.kind === "schema") return tableHints(from, to, before, fact);
  return [];
}

/** The one fact each side lost and gained, when exactly one of each. */
function soleSwap<F extends Fact>(dropped: F[], added: F[]): [F, F] | undefined {
  const drop = dropped[0];
  const add = added[0];
  if (dropped.length !== 1 || added.length !== 1 || drop === undefined || add === undefined) {
    return undefined;
  }
  return [drop, add];
}

function columnHints(
  from: Catalog,
  to: Catalog,
  before: Fact | undefined,
  after: FactOf<"table">,
): string[] {
  if (before?.kind !== "table") return [];
  const dropped = missingFrom(from, to, columnsOf(from, before));
  const added = missingFrom(to, from, columnsOf(to, after));
  const swap = soleSwap(dropped, added);
  if (swap === undefined || swap[0].payload.type !== swap[1].payload.type) return [];
  const [drop, add] = swap;
  return [
    `column ${qualified(add, to)} may be a rename of ${JSON.stringify(drop.name)}: add .renamedFrom(${JSON.stringify(drop.name)}) to it`,
  ];
}

function tableHints(
  from: Catalog,
  to: Catalog,
  before: Fact | undefined,
  after: FactOf<"schema">,
): string[] {
  if (before?.kind !== "schema") return [];
  const dropped = missingFrom(from, to, tablesOf(from, before));
  const added = missingFrom(to, from, tablesOf(to, after));
  const swap = soleSwap(dropped, added);
  if (swap === undefined) return [];
  const [drop, add] = swap;
  const columns = signature(columnsOf(from, drop));
  if (columns === "[]" || columns !== signature(columnsOf(to, add))) return [];
  return [
    `table ${qualified(add, to)} may be a rename of ${JSON.stringify(drop.name)}: add renamedFrom: ${JSON.stringify(drop.name)} to its second callback`,
  ];
}

function columnsOf(catalog: Catalog, table: FactOf<"table">): FactOf<"column">[] {
  return childrenOf(catalog, table).filter((child) => child.kind === "column");
}

function tablesOf(catalog: Catalog, schema: FactOf<"schema">): FactOf<"table">[] {
  return childrenOf(catalog, schema).filter((child) => child.kind === "table");
}

/** The facts of `own` that `other` has no fact of the same name for. */
function missingFrom<F extends Fact>(own: Catalog, other: Catalog, facts: readonly F[]): F[] {
  return facts.filter((fact) => factAt(other, ...namesOf(own, fact)) === undefined);
}

/** A table's columns by name, ignoring their order. */
function signature(columns: readonly FactOf<"column">[]): string {
  return JSON.stringify(
    columns
      .map(({ name, payload }) => JSON.stringify([name, payload.type, payload.notNull]))
      .toSorted((a, b) => a.localeCompare(b)),
  );
}
