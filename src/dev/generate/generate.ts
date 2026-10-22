import {
  CURRENT_FILENAME,
  currentHash,
  DEFAULT_TRACKING_SCHEMA,
  parseCurrent,
  quoteIdentifier,
  readCommitted,
  trackingSchema,
  writeCurrent,
} from "../../runtime/internal/index.ts";
import { migrate } from "../../runtime/migrator/index.ts";
import type { Connect, Driver, FileSystem, MigrationSource } from "../../runtime/ports/index.ts";
import { definitionCatalog, type Catalog, type DefinitionTables } from "../catalog/index.ts";
import { diff } from "../diff/index.ts";
import { introspect, skippedSchemaReason } from "../introspect/index.ts";
import { withShadowDatabases } from "../shadow/index.ts";
import { lineDiff } from "./line-diff.ts";
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
  /**
   * Set when `current.sql` was hand-edited, so generate kept and replayed it as written (ADR-0003):
   * the lines that differ from what generate would have written, `-` for the file and `+` for the
   * generation. Empty when they match. `sql` is then the replayed body.
   */
  readonly diff?: string;
};

/**
 * Diffs the Definition against the Committed migrations, writes the result to `current.sql`, then
 * resets the Dev database and replays the Committed migrations and the Current migration. A
 * hand-edited `current.sql` is replayed as written and left alone.
 */
export async function generate(options: GenerateOptions): Promise<GenerateResult> {
  const {
    driver,
    connect,
    fileSystem,
    definition,
    migrations,
    trackingSchema: trackingName = DEFAULT_TRACKING_SCHEMA,
  } = options;
  const tracking = trackingSchema(trackingName);
  requireModeledSchemas(definition, tracking.name);
  await requireDevDatabase(driver, tracking);
  const path = `${migrations}/${CURRENT_FILENAME}`;
  const edited = await readHandEdited(fileSystem, path);
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

  if (edited !== undefined) {
    const current = { body: edited, hash: await currentHash(edited) };
    await resetDevDatabase(driver, source, tracking, current);
    return { path, sql: edited, diff: lineDiff(edited, (await writeCurrent(sql)).body) };
  }
  if (sql === "") {
    await fileSystem.remove(path);
    await resetDevDatabase(driver, source, tracking);
    return { path, sql: undefined };
  }
  const current = await writeCurrent(sql);
  await fileSystem.writeFile(path, current.content);
  await resetDevDatabase(driver, source, tracking, current);
  return { path, sql: current.body };
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

/** The body of a `current.sql` whose body no longer matches its `--! Generated:` header (ADR-0003). */
async function readHandEdited(fileSystem: FileSystem, path: string): Promise<string | undefined> {
  const content = await fileSystem.readFile(path);
  if (content === undefined) return undefined;
  const parsed = await parseCurrent(content);
  return parsed.edited ? parsed.body : undefined;
}

/**
 * The SQL that builds the Definition into a fresh database. It only creates, so `public`, which
 * template0 ships, stays whether or not the Definition names it, as it does in the Shadow.
 */
async function definitionSql(database: Driver, wanted: Catalog): Promise<string> {
  const existing = [...(await introspect(database))].filter(([path]) => wanted.has(path));
  return diff(new Map(existing), wanted);
}
