import {
  namesOf,
  type Catalog,
  type IndexKeyPayload,
  type IndexPayload,
} from "../catalog/index.ts";

/** Every index in `catalog` with its dotted name, in catalog order. */
export function indexes(catalog: Catalog): [string, IndexPayload][] {
  const found: [string, IndexPayload][] = [];
  for (const fact of catalog.values()) {
    if (fact.kind === "index") found.push([namesOf(catalog, fact).join("."), fact.payload]);
  }
  return found;
}

/** The payload of the one index in `catalog`. */
export function only(catalog: Catalog): IndexPayload {
  const found = indexes(catalog);
  if (found.length !== 1 || found[0] === undefined) {
    throw new Error(`expected one index, found ${found.length}`);
  }
  return found[0][1];
}

/** An expression key, ordered the way `key` is. */
export function expression(
  text: string,
  descending: boolean = false,
  nullsFirst: boolean = descending,
): IndexKeyPayload {
  return { expression: text, descending, nullsFirst };
}

/** A key of an index: ascending with NULLs last, or descending with NULLs first, unless told otherwise. */
export function key(
  column: string,
  descending: boolean = false,
  nullsFirst: boolean = descending,
): IndexKeyPayload {
  return { column, descending, nullsFirst };
}
