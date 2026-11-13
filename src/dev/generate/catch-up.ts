import {
  acquireMigrationLock,
  CURRENT_FILENAME,
  matchingPrefix,
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
import type { Hazard } from "../diff/index.ts";
import { applyDevDiff, type DevDiffTarget } from "./dev-diff.ts";
import { hazardsIn, type HazardLine } from "./hazards.ts";
import { compareRecorded, type RecordedChain } from "./recorded-chain.ts";
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
    }
  | {
      readonly kind: "diffed";
      /** The files the markers now record whose statements never ran in the Dev database. */
      readonly skipped: readonly string[];
      readonly hazards: readonly Hazard[];
    };

export type CatchUpTarget = Omit<DevDiffTarget, "tracking"> & {
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
  /** Whether `migrations` replaces every recorded row rather than following them. */
  readonly replace?: boolean;
};

/**
 * Takes the migrator's lock on the Dev lock's connection, which keeps it until the run ends, so
 * every read and the catch-up after it see the Database as this check did. Refuses a Database that
 * isn't a Dev database (ADR-0016). `lock` passes `signal` and `onWait` to `acquireMigrationLock`.
 */
export async function lockDevDatabase(
  driver: Driver,
  tracking: TrackingSchema,
  lock: {
    readonly signal: AbortSignal | undefined;
    readonly onWait: (() => void) | undefined;
  },
): Promise<void> {
  await driver.session(async (session) => {
    await acquireMigrationLock(session, lock);
    await requireDevDatabase(session, tracking);
  });
}

/**
 * Brings the Dev database up to the Committed files and `current`. Matching markers do nothing,
 * and an empty Database with no tracking tables yet resets, which builds it from the files.
 * With no Current migration recorded and recorded rows that are a prefix of the Committed chain,
 * it applies the new Committed files and `current` as written, then the markers, in one
 * transaction. Otherwise it diffs the Dev database against the Shadow (#768).
 */
export async function catchUp(
  target: CatchUpTarget,
  current?: CurrentMigration,
): Promise<DevDatabaseOutcome> {
  const { driver, source, tracking, committed } = target;
  const chain = committed.map((file) => parseMigration(file));
  const path = await choosePath(driver, tracking, chain, current);
  switch (path.kind) {
    // Stryker disable next-line StringLiteral: 1 survivor: equivalent, since the default returns `path` too.
    case "none":
      return path;
    case "reset":
      await resetDevDatabase(driver, source, tracking, { current });
      return path;
    case "replay":
      return replayNew(driver, tracking, { migrations: path.pending, current });
    case "diff":
      return diffDev(target, { migrations: chain, current, replace: true }, path.skipped);
    // Stryker disable next-line ConditionalExpression: 1 survivor: unreachable, since the type forbids any other kind.
    default:
      return path satisfies never;
  }
}

type CatchUpPath =
  | { readonly kind: "none" }
  | { readonly kind: "reset" }
  | { readonly kind: "replay"; readonly pending: readonly ParsedMigration[] }
  | { readonly kind: "diff"; readonly skipped: readonly string[] };

async function choosePath(
  driver: Driver,
  tracking: TrackingSchema,
  chain: readonly ParsedMigration[],
  current: CurrentMigration | undefined,
): Promise<CatchUpPath> {
  // `lockDevDatabase` let an unmarked Database through only when it holds nothing to keep.
  if (!(await tracking.hasCurrentTable(driver))) return { kind: "reset" };
  return pathFrom(await readTracked(driver, tracking), chain, current);
}

type Tracked = {
  readonly recorded: readonly RecordedMigration[];
  /** False when the migrations table is missing or its last row was left `started` or `failed`. */
  readonly intact: boolean;
  readonly current: string | undefined;
};

async function readTracked(driver: Driver, tracking: TrackingSchema): Promise<Tracked> {
  const current = await tracking.readCurrent(driver);
  // Stryker disable next-line ArrayDeclaration: 1 survivor: equivalent, since a row with no hash mismatches the chain at index 0 as an empty list does.
  if (!(await tracking.hasMigrationsTable(driver))) return { recorded: [], intact: false, current };
  const recorded = await tracking.readRecorded(driver);
  const unfinished = (await tracking.readUnfinished(driver)) !== undefined;
  return { recorded: unfinished ? recorded.slice(0, -1) : recorded, intact: !unfinished, current };
}

function pathFrom(
  tracked: Tracked,
  chain: readonly ParsedMigration[],
  current: CurrentMigration | undefined,
): CatchUpPath {
  const state = tracked.intact ? compareRecorded(tracked.recorded, chain) : "diverged";
  if (state === "match" && tracked.current === current?.hash) return { kind: "none" };
  const pending = chain.slice(tracked.recorded.length);
  if (canReplay(state, tracked.current, pending, current)) return { kind: "replay", pending };
  return { kind: "diff", skipped: skippedFiles(tracked.recorded, chain, current) };
}

/**
 * Whether the Dev database holds a prefix of the chain and no Current migration, and every file to
 * replay can share one transaction (ADR-0020).
 */
function canReplay(
  state: RecordedChain,
  recordedCurrent: string | undefined,
  pending: readonly ParsedMigration[],
  current: CurrentMigration | undefined,
): boolean {
  return (
    state !== "diverged" &&
    recordedCurrent === undefined &&
    pending.every((migration) => !migration.noTransaction) &&
    (current === undefined || !splitCurrentHeader(current.body).noTransaction)
  );
}

/**
 * The files the diff path records without running: the Committed files after the recorded rows
 * that match the chain hash by hash, then `current.sql` when there is one.
 */
function skippedFiles(
  recorded: readonly RecordedMigration[],
  chain: readonly ParsedMigration[],
  current: CurrentMigration | undefined,
): string[] {
  const skipped = chain.slice(matchingPrefix(recorded, chain)).map(({ filename }) => filename);
  return current === undefined ? skipped : [...skipped, CURRENT_FILENAME];
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
 * Diffs the Dev database against the Shadow and applies the result with the markers. A diff with
 * no steps and no skipped file only rewrote the markers, so it reports no change.
 */
async function diffDev(
  target: CatchUpTarget,
  markers: CatchUpMarkers,
  skipped: readonly string[],
): Promise<DevDatabaseOutcome> {
  const { driver, tracking } = target;
  const { sql, hazards } = await applyWithMarkers(
    driver,
    tracking,
    (tx) => applyDevDiff(tx, target),
    markers,
  );
  if (sql === "" && skipped.length === 0) return { kind: "none" };
  return { kind: "diffed", skipped, hazards };
}

/**
 * Runs `apply`, then writes `markers`, in one Dev database transaction. A failure rolls all of it
 * back, so the Dev database stays as it was (#245), and the error names `reset`. Generate never
 * resets on a failure: a visible one beats a silent wipe (#768).
 */
async function applyWithMarkers<T>(
  driver: Driver,
  tracking: TrackingSchema,
  apply: (tx: Queryable) => Promise<T>,
  markers: CatchUpMarkers,
): Promise<T> {
  try {
    return await driver.transaction(async (tx) => {
      const applied = await apply(tx);
      if (markers.replace === true) {
        await tracking.ensureMigrationsTable(tx);
        await tracking.clearMigrations(tx);
      }
      for (const migration of markers.migrations) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- each row references the one before it.
        await tracking.recordMigration(tx, migration);
      }
      await tracking.clearCurrent(tx);
      if (markers.current !== undefined) await tracking.recordCurrent(tx, markers.current.hash);
      return applied;
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `the Dev database didn't catch up, so it was left as it was: ${message}; run smonndb reset to rebuild it from the files`,
      { cause: error },
    );
  }
}
