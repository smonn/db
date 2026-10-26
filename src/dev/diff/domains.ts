import { childrenOf, parentOf, typeName, type Catalog } from "../catalog/index.ts";
import type { DomainType } from "./hazards.ts";

/**
 * The domains the catalogs declare, keyed by their spelling as a column's `type`. A later catalog
 * wins, so pass `from` before `to`.
 */
export function domainTypes(...catalogs: readonly Catalog[]): ReadonlyMap<string, DomainType> {
  const domains = new Map<string, DomainType>();
  for (const catalog of catalogs) {
    for (const fact of catalog.values()) {
      if (fact.kind !== "domain") continue;
      domains.set(typeName(parentOf(catalog, fact).name, fact.name), {
        base: fact.payload.base,
        // A domain's only children are its checks.
        constrained: fact.payload.notNull || childrenOf(catalog, fact).length > 0,
      });
    }
  }
  return domains;
}
