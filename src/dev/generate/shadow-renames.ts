import type { TrackingSchema } from "../../runtime/internal/index.ts";
import type { Driver, Queryable } from "../../runtime/ports/index.ts";
import { appliedRenames, type Catalog, type Rename } from "../catalog/index.ts";
import { renameSql } from "../diff/index.ts";
import { introspect, introspectIn } from "../introspect/index.ts";

export type RenamedShadow = {
  /** The Shadow's catalog with the renames run, so Postgres has rewritten every reference. */
  readonly catalog: Catalog;
  /** The renames that ran: the declared ones whose old name the Shadow held. */
  readonly renames: readonly Rename[];
};

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
  return {
    catalog: await withRenames(shadow, renames, (tx) => introspectIn(tx, tracking)),
    renames,
  };
}

/** Rolls back a transaction whose result `withRenames` already holds. */
class RolledBack extends Error {}

/** Runs `read` on the Shadow after `renames` inside a transaction, then rolls back. */
export async function withRenames<T>(
  shadow: Driver,
  renames: readonly Rename[],
  read: (tx: Queryable) => Promise<T>,
): Promise<T> {
  let result: { readonly value: T } | undefined;
  const outcome = await shadow
    .transaction(async (tx) => {
      if (renames.length > 0) await tx.execute(renames.map((rename) => renameSql(rename)).join(""));
      result = { value: await read(tx) };
      throw new RolledBack();
    })
    .catch((error: unknown) => error);
  if (!(outcome instanceof RolledBack) || result === undefined) throw outcome;
  return result.value;
}
