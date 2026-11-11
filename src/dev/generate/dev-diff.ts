import type { TrackingSchema } from "../../runtime/internal/index.ts";
import type { Queryable } from "../../runtime/ports/index.ts";
import { appliedRenames, type Catalog, type Rename } from "../catalog/index.ts";
import { diff, refuseTypeChanges, renameSql, type Hazard } from "../diff/index.ts";
import { introspectIn } from "../introspect/index.ts";

export type DevDiffTarget = {
  /** What the files describe: the Shadow's catalog with the Current migration applied. */
  readonly shadow: Catalog;
  /** The Definition's declared renames, run where the Dev database still holds the old name. */
  readonly declared: readonly Rename[];
  readonly tracking: TrackingSchema;
};

/**
 * Diffs the Dev database against the Shadow inside `tx` and applies the diff, then throws unless
 * the Dev database matches the Shadow, so the caller's transaction rolls back (#768). Returns the
 * steps it applied and their Hazards.
 */
export async function applyDevDiff(
  tx: Queryable,
  target: DevDiffTarget,
): Promise<{ readonly sql: string; readonly hazards: readonly Hazard[] }> {
  const { shadow, tracking } = target;
  const before = await introspectIn(tx, tracking);
  const renames = appliedRenames(target.declared, before);
  // Stryker disable next-line ConditionalExpression: 1 survivor: equivalent, since an empty savepoint reads the same catalog; the check only saves an introspection.
  const from = renames.length === 0 ? before : await renamedCatalog(tx, renames, tracking);
  refuseTypeChanges({ from, to: shadow });
  const { sql, hazards } = diff(from, shadow, renames);
  await tx.execute(sql);
  const left = diff(await introspectIn(tx, tracking), shadow).sql;
  if (left !== "") throw new Error(`the Dev database still differs from the files:\n${left}`);
  return { sql, hazards };
}

/**
 * The Dev database's catalog with `renames` run, read inside a savepoint that rolls them back, as
 * the Shadow's is (ADR-0024): the diff then opens with the renames.
 */
async function renamedCatalog(
  tx: Queryable,
  renames: readonly Rename[],
  tracking: TrackingSchema,
): Promise<Catalog> {
  await tx.execute("savepoint smonn_db_renames");
  await tx.execute(renames.map((rename) => renameSql(rename)).join(""));
  const catalog = await introspectIn(tx, tracking);
  await tx.execute("rollback to savepoint smonn_db_renames");
  return catalog;
}
