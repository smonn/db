import type { Domain } from "../../runtime/definition/index.ts";
import { quoted, type CatalogBuilder } from "./catalog.ts";
import { elementType, type TypeNames } from "./column-type.ts";

const MAX_CHECK_BYTES = 63;

function refuseCheckName(check: string, where: string): void {
  if (check === "") throw new Error(`${where} has an empty check name`);
  if (new TextEncoder().encode(check).length > MAX_CHECK_BYTES) {
    throw new Error(
      `${where} has the check ${JSON.stringify(check)}, which is over ${MAX_CHECK_BYTES} bytes; Postgres would truncate it`,
    );
  }
}

/**
 * Adds the domain fact and one `domain check` fact per check. The default and checks keep the
 * Definition's text, and the default reads as not volatile: introspecting the Definition database
 * renders them as Postgres does and reads the default's volatility.
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
    defaultVolatile: false,
  });
  for (const [check, expression] of Object.entries(domain.checks)) {
    refuseCheckName(check, `Domain ${quoted([schema, name])}`);
    builder.domainCheck(schema, name, check, { expression });
  }
}
