import type { TrackingSchema } from "../../runtime/internal/index.ts";
import { migrate } from "../../runtime/migrator/index.ts";
import type { Connect, Driver, MigrationSource } from "../../runtime/ports/index.ts";
import {
  declaredRenames,
  definitionCatalog,
  type Catalog,
  type DefinitionTables,
} from "../catalog/index.ts";
import { diff, refuseTypeChanges, type Diff } from "../diff/index.ts";
import { introspect } from "../introspect/index.ts";
import { withShadowDatabases, type ShadowOptions } from "../shadow/index.ts";
import { unmodeledBlockers } from "./blockers.ts";
import { renameInShadow, withRenames } from "./shadow-renames.ts";
import { leftoverAfter, verifyInShadow } from "./verify.ts";

export type ShadowDiffOptions = {
  /** The Dev database, which creates and drops the Shadow and Definition databases. */
  readonly driver: Driver;
  readonly connect: Connect;
  /** The Committed migrations, replayed into the Shadow database. */
  readonly source: MigrationSource;
  readonly definition: DefinitionTables;
  readonly tracking: TrackingSchema;
  readonly shadowOptions: ShadowOptions;
  /** A hand-edited Current migration body: the Shadow runs it instead of the generated SQL. */
  readonly edited?: string;
};

export type ShadowDiff = Diff & {
  /** With `edited`, the differences from the Definition that the edit leaves, as a message. */
  readonly leftover?: string;
};

/**
 * Replays the Committed migrations into the Shadow database, builds the Definition into the
 * Definition database, and diffs the two. A non-empty diff is scanned for Unmodeled blockers, which
 * throw before verification (ADR-0025), then verified in the Shadow (ADR-0013).
 * With a hand edit, the edit runs instead: a SQL error throws, and a leftover difference returns.
 */
export function diffInShadow(options: ShadowDiffOptions): Promise<ShadowDiff> {
  const { driver, connect, source, definition, tracking } = options;
  return withShadowDatabases(
    driver,
    connect,
    async (databases) => {
      await migrate({ driver: databases.shadow, source, trackingSchema: tracking.name });
      await databases.definition.execute(
        await definitionSql(databases.definition, definitionCatalog(definition)),
      );
      const target = await introspect(databases.definition, tracking);
      const { catalog, renames } = await renameInShadow(
        databases.shadow,
        declaredRenames(definition),
        tracking,
      );
      const result = diff(catalog, target, renames);
      if (options.edited !== undefined) {
        const leftover = await leftoverAfter(databases.shadow, options.edited, target, {
          tracking,
          handEdited: true,
        });
        return leftover === undefined ? result : { ...result, leftover };
      }
      refuseTypeChanges({ from: catalog, to: target });
      if (result.sql === "") return result;
      // The scan names objects as the diff does, so it reads the Shadow with the renames run.
      const blockers = await withRenames(databases.shadow, renames, (tx) =>
        unmodeledBlockers(tx, result.scans),
      );
      if (blockers !== undefined) throw new Error(blockers);
      await verifyInShadow(databases.shadow, result.sql, target, tracking);
      return result;
    },
    options.shadowOptions,
  );
}

/**
 * The SQL that builds the Definition into a fresh database. It only creates, so `public`, which
 * template0 ships, stays whether or not the Definition names it, as it does in the Shadow.
 */
async function definitionSql(database: Driver, wanted: Catalog): Promise<string> {
  const existing = [...(await introspect(database))].filter(([path]) => wanted.has(path));
  return diff(new Map(existing), wanted).sql;
}
