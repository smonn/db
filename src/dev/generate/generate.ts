import {
  CURRENT_FILENAME,
  DEFAULT_TRACKING_SCHEMA,
  parseCurrent,
  parseMigration,
  quoteIdentifier,
  readCommitted,
  trackingSchema,
  type TrackingSchema,
  writeCurrent,
} from "../../runtime/internal/index.ts";
import { migrate } from "../../runtime/migrator/index.ts";
import type {
  Connect,
  Driver,
  FileSystem,
  MigrationFile,
  MigrationSource,
} from "../../runtime/ports/index.ts";
import { definitionCatalog, type Catalog, type DefinitionTables } from "../catalog/index.ts";
import { diff } from "../diff/index.ts";
import { introspect, skippedSchemaReason } from "../introspect/index.ts";
import { withShadowDatabases } from "../shadow/index.ts";
import { withDevLock } from "./dev-lock.ts";
import { requireDevDatabase, resetDevDatabase } from "./reset.ts";

export type GenerateOptions = {
  /** The Dev database, which also creates and drops the Shadow and Definition databases. */
  readonly driver: Driver;
  readonly connect: Connect;
  readonly fileSystem: FileSystem;
  readonly definition: DefinitionTables;
  /** The directory holding the Committed migrations and `current.sql`. */
  readonly migrations: string;
  /** The schema `migrate` tracks into. Defaults to `smonn_db`. */
  readonly trackingSchema?: string;
};

export type GenerateResult = {
  readonly path: string;
  /** The Current migration's body, or `undefined` when there was no diff and the file was deleted. */
  readonly sql: string | undefined;
};

/**
 * Diffs the Definition against the Committed migrations, writes the result to `current.sql`, then
 * resets the Dev database and replays the Committed migrations and the Current migration when it
 * has fallen behind them. Holds the Dev lock, so a second run fails at once.
 */
export async function generate(options: GenerateOptions): Promise<GenerateResult> {
  const tracking = trackingSchema(options.trackingSchema ?? DEFAULT_TRACKING_SCHEMA);
  requireModeledSchemas(options.definition, tracking.name);
  const result = await withDevLock(options.driver, "generate", () => generateLocked(options));
  return result;
}

async function generateLocked(options: GenerateOptions): Promise<GenerateResult> {
  const {
    driver,
    connect,
    fileSystem,
    definition,
    migrations,
    trackingSchema: trackingName = DEFAULT_TRACKING_SCHEMA,
  } = options;
  const tracking = trackingSchema(trackingName);
  await requireDevDatabase(driver, tracking);
  const path = `${migrations}/${CURRENT_FILENAME}`;
  await requireGenerated(fileSystem, path);
  await fileSystem.mkdir(migrations);
  const committed = await readCommitted(fileSystem, migrations);
  const source: MigrationSource = { list: () => Promise.resolve(committed) };

  const sql = await withShadowDatabases(driver, connect, async (databases) => {
    await migrate({ driver: databases.shadow, source, trackingSchema: tracking.name });
    await databases.definition.execute(
      await definitionSql(databases.definition, definitionCatalog(definition)),
    );
    return diff(
      await introspect(databases.shadow, tracking),
      await introspect(databases.definition, tracking),
    );
  });

  if (sql === "") {
    await fileSystem.remove(path);
    if (await needsReset(driver, tracking, committed)) {
      await resetDevDatabase(driver, source, tracking);
    }
    return { path, sql: undefined };
  }
  const current = await writeCurrent(sql);
  await fileSystem.writeFile(path, current.content);
  if (await needsReset(driver, tracking, committed, current.hash)) {
    await resetDevDatabase(driver, source, tracking, current);
  }
  return { path, sql: current.body };
}

/**
 * Whether the Dev database has fallen behind the files: it isn't marked yet, its `current` hash
 * differs from the Current migration's, or its last recorded hash differs from the Committed tip.
 */
async function needsReset(
  driver: Driver,
  tracking: TrackingSchema,
  committed: readonly MigrationFile[],
  currentHash?: string,
): Promise<boolean> {
  if (!(await tracking.hasCurrentTable(driver))) return true;
  if ((await tracking.readCurrent(driver)) !== currentHash) return true;
  const chain = committed.map((file) => parseMigration(file));
  return (await tracking.readTip(driver)) !== chain.find((m) => m.sequence === chain.length)?.hash;
}

/** Refuses a schema `introspect` skips, whose tables would otherwise vanish from `current.sql`. */
function requireModeledSchemas(definition: DefinitionTables, trackingName: string): void {
  for (const schema of Object.keys(definition)) {
    const reason = skippedSchemaReason(schema, trackingName);
    if (reason !== undefined) {
      throw new Error(
        `the Definition names schema ${quoteIdentifier(schema)}, which generate skips as ${reason}`,
      );
    }
  }
}

/**
 * Refuses when `current.sql` exists and its body no longer matches its `--! Generated:` header
 * (ADR-0003). Keeping and replaying a hand-edited file comes with #75.
 */
async function requireGenerated(fileSystem: FileSystem, path: string): Promise<void> {
  const content = await fileSystem.readFile(path);
  if (content === undefined) return;
  if ((await parseCurrent(content)).edited) {
    throw new Error(
      `${path} was edited by hand, so generate won't overwrite it; delete it to generate again`,
    );
  }
}

/**
 * The SQL that builds the Definition into a fresh database. It only creates, so `public`, which
 * template0 ships, stays whether or not the Definition names it, as it does in the Shadow.
 */
async function definitionSql(database: Driver, wanted: Catalog): Promise<string> {
  const existing = [...(await introspect(database))].filter(([path]) => wanted.has(path));
  return diff(new Map(existing), wanted);
}
