import {
  acquireMigrationLock,
  CURRENT_FILENAME,
  parseMigration,
  splitCurrentHeader,
  type CurrentMigration,
  type ParsedMigration,
  type RecordedMigration,
  type TrackingSchema,
} from "../../runtime/internal/index.ts";
import type {
  Driver,
  MigrationFile,
  MigrationSource,
  Queryable,
} from "../../runtime/ports/index.ts";
import { hazardsIn, type HazardLine } from "./hazards.ts";
import { compareRecorded } from "./recorded-chain.ts";
import { replay, requireDevDatabase, resetDevDatabase } from "./reset.ts";

/** A Hazard in a Committed file that the catch-up applied. */
type AppliedHazard = HazardLine & { readonly file: string };

/** What generate did to bring the Dev database up to the files. */
export type DevDatabaseOutcome =
  | { readonly kind: "none" }
  | { readonly kind: "reset" }
  | {
      readonly kind: "replayed";
      /** The Committed files it applied, in order, then `current.sql` when it applied that too. */
      readonly files: readonly string[];
      readonly hazards: readonly AppliedHazard[];
    };

export type CatchUpTarget = {
  /** The Dev database, on the Dev lock's connection. */
  readonly driver: Driver;
  readonly source: MigrationSource;
  readonly tracking: TrackingSchema;
  readonly committed: readonly MigrationFile[];
};

/** The tracking rows a catch-up writes beside its steps. */
type CatchUpMarkers = {
  /** The Committed migrations the Dev database now holds beyond its recorded rows, in order. */
  readonly migrations: readonly ParsedMigration[];
  /** The Current migration the Dev database now holds, if any. */
  readonly current: CurrentMigration | undefined;
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

/**
 * Brings the Dev database up to the Committed files and `current`. Matching markers do nothing.
 * With no Current migration recorded and recorded rows that are a prefix of the Committed chain,
 * it applies the new Committed files and `current` as written, then the markers, in one
 * transaction. Anything else resets.
 */
export async function catchUp(
  target: CatchUpTarget,
  current?: CurrentMigration,
): Promise<DevDatabaseOutcome> {
  const { driver, source, tracking, committed } = target;
  const chain = committed.map((file) => parseMigration(file));
  const path = await choosePath(driver, tracking, chain, current);
  switch (path.kind) {
    case "none":
      return path;
    case "reset":
      await resetDevDatabase(driver, source, tracking, { current });
      return path;
    case "replay":
      return replayNew(driver, tracking, { migrations: path.pending, current });
    // Stryker disable next-line ConditionalExpression: 1 survivor: unreachable, since the type forbids any other kind.
    default:
      return path satisfies never;
  }
}

type CatchUpPath =
  | { readonly kind: "none" }
  | { readonly kind: "reset" }
  | { readonly kind: "replay"; readonly pending: readonly ParsedMigration[] };

async function choosePath(
  driver: Driver,
  tracking: TrackingSchema,
  chain: readonly ParsedMigration[],
  current: CurrentMigration | undefined,
): Promise<CatchUpPath> {
  const tracked = await readTracked(driver, tracking);
  return tracked === undefined ? { kind: "reset" } : pathFrom(tracked, chain, current);
}

type Tracked = {
  readonly recorded: readonly RecordedMigration[];
  readonly current: string | undefined;
};

/**
 * The recorded rows and `current` hash, or `undefined` when a tracking table is missing or the
 * last row was left `started` or `failed`.
 */
async function readTracked(driver: Driver, tracking: TrackingSchema): Promise<Tracked | undefined> {
  const tracked =
    (await tracking.hasCurrentTable(driver)) &&
    (await tracking.hasMigrationsTable(driver)) &&
    (await tracking.readUnfinished(driver)) === undefined;
  if (!tracked) return undefined;
  return {
    recorded: await tracking.readRecorded(driver),
    current: await tracking.readCurrent(driver),
  };
}

function pathFrom(
  tracked: Tracked,
  chain: readonly ParsedMigration[],
  current: CurrentMigration | undefined,
): CatchUpPath {
  const state = compareRecorded(tracked.recorded, chain);
  if (state === "match" && tracked.current === current?.hash) return { kind: "none" };
  if (state === "diverged" || tracked.current !== undefined) return { kind: "reset" };
  return replayPath(chain.slice(tracked.recorded.length), current);
}

/** Replays `pending` and `current`, unless one can't share a transaction (ADR-0020). */
function replayPath(
  pending: readonly ParsedMigration[],
  current: CurrentMigration | undefined,
): CatchUpPath {
  const noTransaction =
    pending.some((migration) => migration.noTransaction) ||
    (current !== undefined && splitCurrentHeader(current.body).noTransaction);
  return noTransaction ? { kind: "reset" } : { kind: "replay", pending };
}

async function replayNew(
  driver: Driver,
  tracking: TrackingSchema,
  markers: CatchUpMarkers,
): Promise<DevDatabaseOutcome> {
  const steps = markers.migrations.map(({ filename, body }) => ({ filename, body }));
  if (markers.current !== undefined) {
    steps.push({ filename: CURRENT_FILENAME, body: markers.current.body });
  }
  await applyWithMarkers(
    driver,
    tracking,
    async (tx) => {
      for (const { filename, body } of steps) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- each file builds on the one before it.
        await replay(filename, () => tx.execute(body));
      }
    },
    markers,
  );
  return {
    kind: "replayed",
    files: steps.map(({ filename }) => filename),
    hazards: markers.migrations.flatMap(({ filename, body }) =>
      hazardsIn(body).map(({ kind, statement }) => ({ file: filename, kind, statement })),
    ),
  };
}

/**
 * Runs `apply`, then writes `markers`, in one Dev database transaction. A failure rolls all of it
 * back, so the Dev database stays as it was (#245), and the error names `reset`. Generate never
 * resets on a failure: a visible one beats a silent wipe (#768).
 */
async function applyWithMarkers(
  driver: Driver,
  tracking: TrackingSchema,
  apply: (tx: Queryable) => Promise<void>,
  markers: CatchUpMarkers,
): Promise<void> {
  try {
    await driver.transaction(async (tx) => {
      await apply(tx);
      for (const migration of markers.migrations) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- each row references the one before it.
        await tracking.recordMigration(tx, migration);
      }
      await tracking.clearCurrent(tx);
      if (markers.current !== undefined) await tracking.recordCurrent(tx, markers.current.hash);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `the Dev database didn't catch up, so it was left as it was: ${message}; run smonndb reset to rebuild it from the files`,
      { cause: error },
    );
  }
}
