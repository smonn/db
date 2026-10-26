import type { DriverRow } from "../../runtime/ports/index.ts";
import type { CatalogBuilder } from "../catalog/index.ts";

/** Adds the domains `DOMAINS` read in `schema`, each with the checks `DOMAIN_CHECKS` read on it. */
export function addDomains(
  builder: CatalogBuilder,
  schema: string,
  rows: { readonly domains: readonly DriverRow[]; readonly checks: readonly DriverRow[] },
): void {
  for (const domain of rows.domains.filter((row) => row["schema"] === schema)) {
    const name = String(domain["name"]);
    const expression = domain["default_expression"];
    builder.domain(schema, name, {
      base: String(domain["base"]),
      notNull: domain["not_null"] === true,
      default: typeof expression === "string" ? expression : null,
    });
    for (const check of rows.checks) {
      if (check["schema"] !== schema || check["domain"] !== name) continue;
      builder.domainCheck(schema, name, String(check["name"]), {
        expression: String(check["expression"]),
      });
    }
  }
}
