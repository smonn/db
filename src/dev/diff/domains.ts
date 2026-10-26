import { childrenOf, parentOf, typeName, type Catalog } from "../catalog/index.ts";
import type { DomainType } from "./hazards.ts";

export type DeclaredDomain = DomainType & {
  /** The default calls a volatile function, so a column filled from it gets one value per row. */
  readonly volatileDefault: boolean;
};

/**
 * The domains the catalogs declare, keyed by their spelling as a column's `type`. A later catalog
 * wins, so pass `from` before `to`.
 */
export function domainTypes(...catalogs: readonly Catalog[]): ReadonlyMap<string, DeclaredDomain> {
  const domains = new Map<string, DeclaredDomain>();
  for (const catalog of catalogs) {
    for (const fact of catalog.values()) {
      if (fact.kind !== "domain") continue;
      domains.set(typeName(parentOf(catalog, fact).name, fact.name), {
        base: fact.payload.base,
        // A domain's only children are its checks.
        constrained: fact.payload.notNull || childrenOf(catalog, fact).length > 0,
        volatileDefault: fact.payload.defaultVolatile,
      });
    }
  }
  return domains;
}
