import {
  childrenOf,
  type Catalog,
  type Fact,
  type GeneratedPayload,
  type Key,
} from "../catalog/index.ts";
import type { Catalogs } from "./actions.ts";
import { swapOf } from "./enum-swap.ts";

/**
 * The columns `ALTER COLUMN` can't convert: Postgres can't make a plain column generated, switch
 * a column between stored and virtual, or drop the expression of a virtual one.
 */
export function rebuiltColumns({ from, to }: Catalogs): ReadonlyMap<Key, Fact> {
  const rebuilt = new Map<Key, Fact>();
  for (const [key, before] of from) {
    const after = to.get(key);
    if (before.kind !== "column" || after?.kind !== "column") continue;
    if (needsRebuild({ from, to }, before, after)) rebuilt.set(key, after);
  }
  return rebuilt;
}

function needsRebuild({ from, to }: Catalogs, before: Fact, after: Fact): boolean {
  const was = generation(from, before);
  const now = generation(to, after);
  if (was?.storage === now?.storage) return false;
  return !(now === undefined && was?.storage === "stored");
}

function generation(catalog: Catalog, column: Fact): GeneratedPayload | undefined {
  const child = childrenOf(catalog, column).find((fact) => fact.kind === "generated");
  return child?.kind === "generated" ? child.payload : undefined;
}

/** Whether the column changes type, or keeps the name of an enum that swaps (ADR-0023). */
export function retyped(column: Key, catalogs: Catalogs): boolean {
  const before = catalogs.from.get(column);
  const after = catalogs.to.get(column);
  return (
    before?.kind === "column" &&
    after?.kind === "column" &&
    (before.payload.type !== after.payload.type ||
      swapOf(after.payload.type, catalogs) !== undefined)
  );
}

/**
 * `catalog` without the rebuilt columns, the facts under them, and the facts that name them, which
 * `columnsNamed` reads off each fact.
 */
export function without(
  catalog: Catalog,
  rebuilt: ReadonlyMap<Key, Fact>,
  columnsNamed: (fact: Fact) => readonly string[],
): Catalog {
  const columns = [...rebuilt.values()];
  return new Map(
    [...catalog].filter(
      ([key, fact]) =>
        !rebuilt.has(key) &&
        !(fact.parent !== undefined && rebuilt.has(fact.parent)) &&
        !columns.some(
          (column) => column.parent === fact.parent && columnsNamed(fact).includes(column.name),
        ),
    ),
  );
}
