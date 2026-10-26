import {
  CURRENT_FILENAME,
  currentHash,
  DEFAULT_TRACKING_SCHEMA,
  parseCurrent,
  parseMigration,
  readCommitted,
  splitCurrentHeader,
  trackingSchema,
  writeMigration,
} from "../../runtime/internal/index.ts";
import { verify } from "../../runtime/migrator/index.ts";
import type { Driver, FileSystem } from "../../runtime/ports/index.ts";
import type { HazardKind } from "../diff/index.ts";
import { withDevLock } from "./dev-lock.ts";
import { hazardRefusal } from "./hazard-refusal.ts";

export type CommitOptions = {
  /** The Dev database, which `generate` last replayed `current.sql` into. */
  readonly driver: Driver;
  readonly fileSystem: FileSystem;
  /** The directory holding the Committed migrations and `current.sql`. */
  readonly migrations: string;
  /** Kebab-case, named in the file as `000001-<slug>.sql`. */
  readonly slug: string;
  /** The schema `migrate` tracks into. Defaults to `smonn_db`. */
  readonly trackingSchema?: string;
  /** The Hazard kinds the caller accepts (ADR-0015); `commit` refuses any other kind in the file. */
  readonly accept: readonly HazardKind[];
};

export type CommitResult = {
  /** The Committed migration it wrote. */
  readonly path: string;
};

const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/**
 * Freezes `current.sql` into the next Committed migration, chained onto the tip (ADR-0008), then
 * records it and clears the tracking schema's `current` table in one Dev database transaction and
 * deletes `current.sql`. A `--! no-transaction` header on its first line carries into the Committed
 * file (ADR-0020). Refuses while `current.sql` has a Hazard kind outside `accept`, and unless
 * the Dev database holds `current.sql` as it reads now and every Committed migration before it.
 */
export function commit(options: CommitOptions): Promise<CommitResult> {
  return withDevLock(options.driver, "commit", (driver) => commitLocked({ ...options, driver }));
}

async function commitLocked(options: CommitOptions): Promise<CommitResult> {
  const { driver, fileSystem, migrations, slug } = options;
  const tracking = trackingSchema(options.trackingSchema ?? DEFAULT_TRACKING_SCHEMA);
  if (!KEBAB_CASE.test(slug)) {
    throw new Error(`slug ${JSON.stringify(slug)} must be kebab-case, such as create-users`);
  }
  const currentPath = `${migrations}/${CURRENT_FILENAME}`;
  const content = await fileSystem.readFile(currentPath);
  if (content === undefined) throw new Error(`${currentPath} doesn't exist; run generate first`);
  const { body } = await parseCurrent(content);
  const refusal = hazardRefusal(body, options.accept);
  if (refusal !== undefined) throw new Error(refusal);

  const committed = await readCommitted(fileSystem, migrations);
  await verify({ list: () => Promise.resolve(committed) });
  const chain = committed.map((file) => parseMigration(file));
  const tip = chain.find((migration) => migration.sequence === chain.length);
  const filename = `${String(chain.length + 1).padStart(6, "0")}-${slug}.sql`;
  const { noTransaction, sql } = splitCurrentHeader(body);
  const migration = await writeMigration(filename, tip?.hash, sql, { noTransaction });
  const path = `${migrations}/${filename}`;

  let wrote = false;
  try {
    await driver.transaction(async (tx) => {
      if ((await tracking.readCurrent(tx)) !== (await currentHash(body))) {
        throw new Error(
          `the Dev database hasn't replayed ${currentPath} as it reads now; run generate first`,
        );
      }
      const recorded = await tracking.readRecorded(tx);
      if (recorded.length !== chain.length || recorded.at(-1)?.hash !== tip?.hash) {
        throw new Error(
          `the Dev database's Committed migrations don't match the files in ${migrations}; run generate first`,
        );
      }
      await fileSystem.writeFile(path, migration.content);
      wrote = true;
      await tracking.recordMigration(tx, parseMigration(migration));
      await tracking.clearCurrent(tx);
    });
  } catch (error) {
    if (wrote) await fileSystem.remove(path);
    throw error;
  }
  await fileSystem.remove(currentPath);
  return { path };
}
