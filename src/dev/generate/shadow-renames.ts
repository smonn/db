import type { TrackingSchema } from "../../runtime/internal/index.ts";
import type { Driver } from "../../runtime/ports/index.ts";
import { appliedRenames, type Catalog, type Rename } from "../catalog/index.ts";
import { renameSql } from "../diff/index.ts";
import { introspect, introspectIn } from "../introspect/index.ts";

export type RenamedShadow = {
  /** The Shadow's catalog with the renames run, so Postgres has rewritten every reference. */
  readonly catalog: Catalog;
  /** The renames that ran: the declared ones whose old name the Shadow held. */
  readonly renames: readonly Rename[];
};

/** Carries the catalog out of a transaction that has to roll back. */
class RolledBack extends Error {
  readonly catalog: Catalog;

  constructor(catalog: Catalog) {
    super("rolled back the declared renames");
    this.catalog = catalog;
  }
}

/**
 * Runs the declared renames on the Shadow inside a transaction, reads the catalog, and rolls back
 * (ADR-0024). Postgres follows a rename by OID, so the catalog diffs against the Definition with
 * every default, check, and expression already pointing at the new name.
 */
export async function renameInShadow(
  shadow: Driver,
  declared: readonly Rename[],
  tracking: TrackingSchema,
): Promise<RenamedShadow> {
  const before = await introspect(shadow, tracking);
  const renames = appliedRenames(declared, before);
  if (renames.length === 0) return { catalog: before, renames };
  const outcome = await shadow
    .transaction(async (tx) => {
      await tx.execute(renames.map((rename) => renameSql(rename)).join("\n"));
      throw new RolledBack(await introspectIn(tx, tracking));
    })
    .catch((error: unknown) => error);
  if (!(outcome instanceof RolledBack)) throw outcome;
  return { catalog: outcome.catalog, renames };
}
