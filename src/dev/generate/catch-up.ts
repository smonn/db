import {
  acquireMigrationLock,
  parseMigration,
  type CurrentMigration,
  type TrackingSchema,
} from "../../runtime/internal/index.ts";
import type { Driver, MigrationFile, MigrationSource } from "../../runtime/ports/index.ts";
import { requireDevDatabase, resetDevDatabase } from "./reset.ts";

/** What generate did to bring the Dev database up to the files. */
export type DevDatabaseOutcome = { readonly kind: "none" } | { readonly kind: "reset" };

export type CatchUpTarget = {
  /** The Dev database, on the Dev lock's connection. */
  readonly driver: Driver;
  readonly source: MigrationSource;
  readonly tracking: TrackingSchema;
  readonly committed: readonly MigrationFile[];
};

/**
 * Takes the migrator's lock on the Dev lock's connection, which keeps it until the run ends, so
 * every read and the catch-up after it see the Database as this check did. Refuses a Database that
 * isn't a Dev database (ADR-0016).
 */
export async function lockDevDatabase(driver: Driver, tracking: TrackingSchema): Promise<void> {
  await driver.session(async (session) => {
    await acquireMigrationLock(session);
    await requireDevDatabase(session, tracking);
  });
}

/** Resets the Dev database when it has fallen behind the files. */
export async function catchUp(
  { driver, source, tracking, committed }: CatchUpTarget,
  current?: CurrentMigration,
): Promise<DevDatabaseOutcome> {
  if (!(await needsReset(driver, tracking, committed, current?.hash))) return { kind: "none" };
  await resetDevDatabase(driver, source, tracking, { current });
  return { kind: "reset" };
}

/**
 * Whether the Dev database has fallen behind the files: it isn't marked yet, its `current` hash
 * differs from the Current migration's, or its last recorded hash differs from the Committed tip.
 */
async function needsReset(
  driver: Driver,
  tracking: TrackingSchema,
  committed: readonly MigrationFile[],
  current?: string,
): Promise<boolean> {
  if (!(await tracking.hasCurrentTable(driver))) return true;
  if ((await tracking.readCurrent(driver)) !== current) return true;
  const chain = committed.map((file) => parseMigration(file));
  return (await tracking.readTip(driver)) !== chain.find((m) => m.sequence === chain.length)?.hash;
}
