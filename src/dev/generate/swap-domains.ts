import { quoteIdentifier } from "../../runtime/internal/index.ts";
import type { Queryable } from "../../runtime/ports/index.ts";
import { parentOf, qualified, type Catalog } from "../catalog/index.ts";
import { enumSwaps } from "../diff/index.ts";

// A domain over the enum or over its array type.
const DOMAINS_OVER = `
select n.nspname as schema, t.typname as name
from pg_catalog.pg_type t
  join pg_catalog.pg_namespace n on n.oid = t.typnamespace
  join pg_catalog.pg_type e on t.typbasetype in (e.oid, e.typarray)
  join pg_catalog.pg_namespace en on en.oid = e.typnamespace
where t.typtype = 'd' and en.nspname = $1 and e.typname = $2
order by n.nspname, t.typname`;

/**
 * Refuses an enum type swap while a domain depends on the enum, naming each domain: Postgres
 * can't move a domain to another base type, so the old type couldn't drop (ADR-0023). Reads the
 * Shadow, since domains aren't catalog facts yet.
 */
export async function refuseSwapUnderDomains(
  shadow: Queryable,
  catalogs: { readonly from: Catalog; readonly to: Catalog },
): Promise<void> {
  const swapped = await Promise.all(
    [...enumSwaps(catalogs).values()].map(async ({ before }) => {
      const schema = parentOf(catalogs.from, before).name;
      const { rows } = await shadow.query(DOMAINS_OVER, [schema, before.name]);
      return { before, rows };
    }),
  );
  for (const { before, rows } of swapped) {
    if (rows.length === 0) continue;
    const domains = rows.map(
      (row) => `${quoteIdentifier(String(row["schema"]))}.${quoteIdentifier(String(row["name"]))}`,
    );
    throw new Error(
      `Generate can't remove or reorder a label of the enum ${qualified(before, catalogs.from)} while a domain depends on it: ${domains.join(", ")}. Postgres can't move a domain to a new type, so the swap couldn't drop the old one. Hand edit the Current migration to drop each domain before the swap and create it again after.`,
    );
  }
}
