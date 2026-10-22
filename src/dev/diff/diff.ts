import type { Catalog, Fact } from "../catalog/index.ts";

type Action =
  | { readonly kind: "create schema"; readonly path: string; readonly fact: Fact }
  | { readonly kind: "create table"; readonly path: string; readonly fact: Fact }
  | { readonly kind: "add column"; readonly path: string; readonly fact: Fact };

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
      actions.push({ kind: "create schema", path, fact });
    } else if (fact.kind === "table") {
      actions.push({ kind: "create table", path, fact });
    } else if (from.has(fact.parent)) {
      actions.push({ kind: "add column", path, fact });
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

function render({ kind, path, fact }: Action, to: Catalog): string {
  if (kind === "create schema") return `create schema ${quote(fact.name)};`;
  if (kind === "create table") {
    const columns = [...to.values()]
      .filter((child) => child.kind === "column" && child.parent === path)
      .map((child) => `  ${columnDefinition(child)}`);
    const body = columns.length === 0 ? "()" : `(\n${columns.join(",\n")}\n)`;
    return `create table ${qualified(fact, to)} ${body};`;
  }
  return `alter table ${qualified(parentOf(fact, to), to)} add column ${columnDefinition(fact)};`;
}

function columnDefinition(fact: Fact): string {
  if (fact.kind !== "column") throw new Error(`${fact.kind} ${fact.name} isn't a column`);
  const { type, notNull } = fact.payload;
  return `${quote(fact.name)} ${type}${notNull ? " not null" : ""}`;
}

function qualified(table: Fact, catalog: Catalog): string {
  return `${quote(parentOf(table, catalog).name)}.${quote(table.name)}`;
}

function parentOf(fact: Fact, catalog: Catalog): Fact {
  const parent = fact.parent === undefined ? undefined : catalog.get(fact.parent);
  if (parent === undefined)
    throw new Error(`${fact.kind} ${fact.name} has no parent in the catalog`);
  return parent;
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
