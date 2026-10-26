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
 * with identical columns, or an enum that removes one label and adds one at the same position.
 * A guess only prints; it never reaches the SQL.
 */
export function renameHints(from: Catalog, to: Catalog): string[] {
  const hints: string[] = [];
  for (const [key, fact] of to) {
    const before = from.get(key);
    if (before !== undefined) hints.push(...hintsFor(from, to, before, fact));
  }
  return hints;
}

function hintsFor(from: Catalog, to: Catalog, before: Fact, after: Fact): string[] {
  if (before.kind === "table" && after.kind === "table") {
    return columnHints(from, to, before, after);
  }
  return typeHints(from, to, before, after);
}

function typeHints(from: Catalog, to: Catalog, before: Fact, after: Fact): string[] {
  if (before.kind === "schema" && after.kind === "schema") {
    return tableHints(from, to, before, after);
  }
  if (before.kind === "enum" && after.kind === "enum") return labelHints(to, before, after);
  return [];
}

function columnHints(
  from: Catalog,
  to: Catalog,
  before: FactOf<"table">,
  after: FactOf<"table">,
): string[] {
  const dropped = missingFrom(from, to, columnsOf(from, before));
  const added = missingFrom(to, from, columnsOf(to, after));
  const pair = onlyPair(dropped, added);
  if (pair === undefined) return [];
  const [drop, add] = pair;
  if (drop.payload.type !== add.payload.type) return [];
  return [
    `column ${qualified(add, to)} may be a rename of ${JSON.stringify(drop.name)}: add .renamedFrom(${JSON.stringify(drop.name)}) to it`,
  ];
}

function tableHints(
  from: Catalog,
  to: Catalog,
  before: FactOf<"schema">,
  after: FactOf<"schema">,
): string[] {
  const dropped = missingFrom(from, to, tablesOf(from, before));
  const added = missingFrom(to, from, tablesOf(to, after));
  const pair = onlyPair(dropped, added);
  if (pair === undefined) return [];
  const [drop, add] = pair;
  const columns = signature(columnsOf(from, drop));
  if (columns === "[]" || columns !== signature(columnsOf(to, add))) return [];
  return [
    `table ${qualified(add, to)} may be a rename of ${JSON.stringify(drop.name)}: add renamedFrom: ${JSON.stringify(drop.name)} to its second callback`,
  ];
}

function labelHints(to: Catalog, before: FactOf<"enum">, after: FactOf<"enum">): string[] {
  const removed = before.payload.labels.filter((label) => !after.payload.labels.includes(label));
  const added = after.payload.labels.filter((label) => !before.payload.labels.includes(label));
  const pair = onlyPair(removed, added);
  if (pair === undefined) return [];
  const [drop, add] = pair;
  if (before.payload.labels.indexOf(drop) !== after.payload.labels.indexOf(add)) return [];
  return [
    `enum ${qualified(after, to)} may rename the label ${JSON.stringify(drop)} to ${JSON.stringify(add)}: add renamedLabels: { ${JSON.stringify(add)}: ${JSON.stringify(drop)} } to its options`,
  ];
}

/** The one dropped and the one added item, or undefined unless each side has exactly one. */
function onlyPair<T>(dropped: readonly T[], added: readonly T[]): [T, T] | undefined {
  const [drop, add] = [dropped[0], added[0]];
  if (dropped.length !== 1 || added.length !== 1 || drop === undefined || add === undefined) {
    return undefined;
  }
  return [drop, add];
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
