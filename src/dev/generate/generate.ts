import {
  COMMITTED_FILENAME,
  CURRENT_FILENAME,
  DEFAULT_TRACKING_SCHEMA,
  parseCurrent,
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
import { introspect } from "../introspect/index.ts";
import { withShadowDatabases } from "../shadow/index.ts";
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
 * resets the Dev database and replays the Committed migrations and the Current migration.
 */
export async function generate(options: GenerateOptions): Promise<GenerateResult> {
  const {
    driver,
    connect,
    fileSystem,
    definition,
    migrations,
    trackingSchema = DEFAULT_TRACKING_SCHEMA,
  } = options;
  await requireDevDatabase(driver, trackingSchema);
  const path = `${migrations}/${CURRENT_FILENAME}`;
  await requireGenerated(fileSystem, path);
  await fileSystem.mkdir(migrations);
  const committed = await readCommitted(fileSystem, migrations);
  const source: MigrationSource = { list: () => Promise.resolve(committed) };

  const sql = await withShadowDatabases(driver, connect, async (databases) => {
    await migrate({ driver: databases.shadow, source, trackingSchema });
    await databases.definition.execute(
      await definitionSql(databases.definition, definitionCatalog(definition)),
    );
    return diff(
      await introspect(databases.shadow, trackingSchema),
      await introspect(databases.definition, trackingSchema),
    );
  });

  if (sql === "") {
    await fileSystem.remove(path);
    await resetDevDatabase(driver, source, trackingSchema);
    return { path, sql: undefined };
  }
  const current = await writeCurrent(sql);
  await fileSystem.writeFile(path, current.content);
  await resetDevDatabase(driver, source, trackingSchema, current);
  return { path, sql: current.body };
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

async function readCommitted(fileSystem: FileSystem, directory: string): Promise<MigrationFile[]> {
  const filenames = (await fileSystem.list(directory)).filter((name) =>
    COMMITTED_FILENAME.test(name),
  );
  return Promise.all(
    filenames.map(async (filename) => ({
      filename,
      content: (await fileSystem.readFile(`${directory}/${filename}`)) ?? "",
    })),
  );
}
