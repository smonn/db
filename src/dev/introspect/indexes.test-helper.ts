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

/** A key of an index: ascending with NULLs last, or descending with NULLs first, unless told otherwise. */
export function key(
  column: string,
  descending: boolean = false,
  nullsFirst: boolean = descending,
): IndexKeyPayload {
  return { column, descending, nullsFirst };
}
