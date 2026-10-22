import { childrenOf, namesOf, parentOf, type Catalog, type Fact } from "../catalog/index.ts";

type Action = {
  readonly kind: "create schema" | "create table" | "add column";
  readonly fact: Fact;
};

const PHASES: readonly Action["kind"][] = ["create schema", "create table", "add column"];

/** The SQL that turns a database with catalog `from` into one with catalog `to`. */
export function diff(from: Catalog, to: Catalog): string {
  for (const [path, fact] of from) {
    if (!to.has(path)) throw new Error(`Can't drop ${fact.kind} ${path} yet`);
  }

  const actions: Action[] = [];
  for (const [path, fact] of to) {
    const before = from.get(path);
    if (before !== undefined) {
      if (!equal(before.payload, fact.payload)) {
        throw new Error(`Can't alter ${fact.kind} ${path} yet`);
      }
    } else if (fact.kind === "schema") {
      actions.push({ kind: "create schema", fact });
    } else if (fact.kind === "table") {
      actions.push({ kind: "create table", fact });
    } else if (from.has(fact.parent)) {
      actions.push({ kind: "add column", fact });
    }
  }

  return order(actions)
    .map((action) => `${render(action, to)}\n`)
    .join("\n");
}

function order(actions: readonly Action[]): Action[] {
  // Stable, so ties keep the target catalog's order: Postgres can't reorder columns later.
  return actions.toSorted((a, b) => PHASES.indexOf(a.kind) - PHASES.indexOf(b.kind));
}

function render({ kind, fact }: Action, to: Catalog): string {
  if (kind === "create schema") return `create schema ${quote(fact.name)};`;
  if (kind === "create table") {
    const columns = childrenOf(to, fact)
      .filter((child) => child.kind === "column")
      .map((child) => `  ${columnDefinition(child)}`);
    const body = columns.length === 0 ? "()" : `(\n${columns.join(",\n")}\n)`;
    return `create table ${qualified(fact, to)} ${body};`;
  }
  return `alter table ${qualified(parentOf(to, fact), to)} add column ${columnDefinition(fact)};`;
}

function columnDefinition(fact: Fact): string {
  if (fact.kind !== "column") throw new Error(`${fact.kind} ${fact.name} isn't a column`);
  const { type, notNull } = fact.payload;
  return `${quote(fact.name)} ${type}${notNull ? " not null" : ""}`;
}

function qualified(fact: Fact, catalog: Catalog): string {
  return namesOf(catalog, fact)
    .map((name) => quote(name))
    .join(".");
}

function quote(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
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
