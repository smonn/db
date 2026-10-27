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

/** Rolls back a transaction, carrying the value `withRenames` read before it. */
class RolledBack<T> extends Error {
  readonly value: T;

  constructor(value: T) {
    super();
    this.value = value;
  }
}

/** Runs `read` on the Shadow after `renames` inside a transaction, then rolls back. */
export async function withRenames<T>(
  shadow: Driver,
  renames: readonly Rename[],
  read: (tx: Queryable) => Promise<T>,
): Promise<T> {
  const outcome = await shadow
    .transaction(async (tx) => {
      if (renames.length > 0) await tx.execute(renames.map((rename) => renameSql(rename)).join(""));
      throw new RolledBack(await read(tx));
    })
    .catch((error: unknown) => error);
  if (isRolledBack<T>(outcome)) return outcome.value;
  throw outcome;
}

function isRolledBack<T>(outcome: unknown): outcome is RolledBack<T> {
  return outcome instanceof RolledBack;
}
