import { quoteIdentifier } from "../../runtime/internal/index.ts";
import { namesOf, type Catalog, type Fact } from "./catalog.ts";

/** Deep equality that ignores object key order, so every catalog comparison agrees. */
export function arePayloadsEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const aEntries = Object.entries(a);
  const bValues = new Map(Object.entries(b));
  return (
    aEntries.length === bValues.size &&
    aEntries.every(([key, value]) => bValues.has(key) && arePayloadsEqual(value, bValues.get(key)))
  );
}

/** The fact's quoted, dotted name, such as `"auth"."users"`. */
export function qualified(fact: Fact, catalog: Catalog): string {
  return namesOf(catalog, fact)
    .map((name) => quoteIdentifier(name))
    .join(".");
}
