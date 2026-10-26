import type { Domain } from "../../runtime/definition/index.ts";
import { quoted, type CatalogBuilder } from "./catalog.ts";
import { elementType, type TypeNames } from "./column-type.ts";

/**
 * Adds the domain fact and one `domain check` fact per check. The default and checks keep the
 * Definition's text: introspecting the Definition database renders them as Postgres does.
 */
export function addDomain(
  builder: CatalogBuilder,
  { schema, name, names }: { readonly schema: string; readonly name: string; names: TypeNames },
  domain: Domain,
): void {
  builder.domain(schema, name, {
    base: elementType(domain.base, names, `Domain ${quoted([schema, name])}`),
    notNull: domain.notNull,
    default: domain.default ?? null,
  });
  for (const [check, expression] of Object.entries(domain.checks)) {
    builder.domainCheck(schema, name, check, { expression });
  }
}
