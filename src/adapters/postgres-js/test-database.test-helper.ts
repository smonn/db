import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import postgres, { type Sql } from "postgres";
import { afterAll, afterEach, beforeAll } from "vitest";
import { acquireMigrationLock, MIGRATION_LOCK_KEY } from "../../runtime/internal/index.ts";
import type { Connect, Driver, Queryable } from "../../runtime/ports/index.ts";
import { postgresJsConnect } from "./connect.ts";
import { postgresJsDriver } from "./driver.ts";
import { postgresJsConnection, postgresJsTypes } from "./value-types.ts";

type OwnPoolOptions = {
  /** Defaults to this database's `url`. */
  readonly url?: string;
  readonly max?: number;
};

export type TestDatabase = {
  readonly name: string;
  /** The connection URL of this database. */
  readonly url: string;
  readonly driver: Driver;
  /**
   * Opens a pool of its own on this database, for a test that breaks a connection. postgres.js
   * hands a connection whose backend ended mid-statement a stale error and never ends it (#154).
   */
  readonly ownPool: (options?: OwnPoolOptions) => Driver;
  /** Opens another database on the same server; the caller closes it. */
  readonly connect: Connect;
  /** Like `connect`, with a pool of one connection, so a second connection would wait forever. */
  readonly connectSingle: Connect;
};

const ignoreNotice = (): void => {};

const missingServerUrl =
  "Run `node scripts/test-db.ts` to start a Postgres 18 server for this checkout, or set DATABASE_URL to one";

/** Explains a rejected login (SQLSTATE class 28), which most often means another project's Postgres holds the port. */
export function explainConnectionError(error: unknown, serverUrl: string): unknown {
  if (!(error instanceof postgres.PostgresError) || !error.code.startsWith("28")) {
    return error;
  }
  const { host } = new URL(serverUrl);
  return new Error(
    `DATABASE_URL's server at ${host} rejected the login (${error.message}); another server may hold that port`,
    { cause: error },
  );
}

/**
 * A test that times out leaves its session open, and a session advisory lock (the Dev lock) would
 * fail every later test in the file (#286). The terminated connection never releases to the pool,
 * so the pool must end with `timeout: 0` instead of waiting on it.
 */
async function endAdvisoryLockSessions(sql: Sql): Promise<void> {
  await sql.unsafe(
    "select pg_terminate_backend(pid) from pg_locks where locktype = 'advisory' and granted and database = (select oid from pg_database where datname = current_database()) and pid <> pg_backend_pid()",
  );
}

/**
 * Creates a fresh database on `DATABASE_URL`'s server before the test file and drops it after.
 * Every test in the file shares it, so give each test its own table names.
 */
export function useTestDatabase(): TestDatabase {
  const serverUrl = process.env["DATABASE_URL"];
  if (serverUrl === undefined || serverUrl === "") {
    throw new Error(missingServerUrl);
  }
  const name = `smonn_db_test_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;

  const admin = postgres(serverUrl, { max: 1, onnotice: ignoreNotice });
  const client = ({ url: clientUrl = url.href, max = 10 }: OwnPoolOptions = {}): Sql =>
    postgres(clientUrl, {
      max,
      onnotice: ignoreNotice,
      types: postgresJsTypes,
      connection: postgresJsConnection,
    });
  const sql = client();
  const ownPools: Sql[] = [];

  beforeAll(async () => {
    await admin.unsafe(`create database ${name}`).catch((error: unknown) => {
      throw explainConnectionError(error, serverUrl);
    });
  });
  afterEach(() => endAdvisoryLockSessions(sql));
  afterAll(async () => {
    await Promise.all([
      sql.end({ timeout: 0 }),
      ...ownPools.map((pool) => pool.end({ timeout: 0 })),
    ]);
    await admin.unsafe(`drop database ${name} with (force)`).catch((error: unknown) => {
      throw explainConnectionError(error, serverUrl);
    });
    await admin.end();
  });

  return {
    name,
    url: url.href,
    driver: postgresJsDriver(sql),
    ownPool: (options) => {
      const pool = client(options);
      ownPools.push(pool);
      return postgresJsDriver(pool);
    },
    connect: postgresJsConnect(serverUrl, { onnotice: ignoreNotice }),
    connectSingle: postgresJsConnect(serverUrl, { max: 1, onnotice: ignoreNotice }),
  };
}

const activeBackends =
  "from pg_stat_activity where pid <> pg_backend_pid() and datname = current_database() and state = 'active' and strpos(query, $1) > 0";

async function untilActiveBackend(driver: Driver, select: string, fragment: string): Promise<void> {
  const statement = `select ${select} as hit ${activeBackends}`;
  const { rows } = await driver.query(statement, [fragment]);
  if (!rows.some((row) => row["hit"] === true)) {
    await setTimeout(10);
    await untilActiveBackend(driver, select, fragment);
  }
}

/**
 * Waits until another backend in this database runs a statement containing `fragment`, then
 * terminates it. Other test files' databases are out of reach, and a backend that ends first
 * doesn't count as terminated.
 */
export function terminateBackendRunning(driver: Driver, fragment: string): Promise<void> {
  return untilActiveBackend(driver, "pg_terminate_backend(pid)", fragment);
}

/** Waits until another backend in this database runs a statement containing `fragment`. */
export function backendRunning(driver: Driver, fragment: string): Promise<void> {
  return untilActiveBackend(driver, "true", fragment);
}

const lockAttempts = [
  `pg_try_advisory_lock(${MIGRATION_LOCK_KEY})`,
  `pg_advisory_lock(${MIGRATION_LOCK_KEY})`,
];

export async function backendPid(queryable: Queryable): Promise<number> {
  const { rows } = await queryable.query("select pg_backend_pid() as pid");
  return Number(rows[0]?.["pid"]);
}

type AttemptOptions = {
  /** The backend that holds the lock, which also ran an attempt. */
  readonly holderPid?: number;
  /** Stops the wait early, such as once the contender finished and will never try. */
  readonly gaveUp?: () => boolean;
};

/**
 * Waits until another backend in this database has tried to take the migration lock. A polling
 * `acquireMigrationLock` never queues, so the attempt shows only as the last statement of the
 * backend, running or idle; a regression to a blocking `pg_advisory_lock` shows the same way. A
 * fixed sleep samples too early under load, and a regression passes.
 */
export async function untilMigrationLockAttempted(
  driver: Driver,
  { holderPid = 0, gaveUp = () => false }: AttemptOptions = {},
): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (gaveUp()) return;
    // oxlint-disable-next-line eslint/no-await-in-loop -- each poll waits on the one before it.
    const { rows } = await driver.query(
      "select exists (select from pg_stat_activity where pid <> pg_backend_pid() and pid <> $1::int and datname = current_database() and (state <> 'active' or wait_event_type = 'Lock') and (strpos(query, $2) > 0 or strpos(query, $3) > 0)) as hit",
      [holderPid, ...lockAttempts],
    );
    if (rows[0]?.["hit"] === true) return;
    // oxlint-disable-next-line eslint/no-await-in-loop -- see above.
    await setTimeout(10);
  }
  throw new Error("nothing tried to take the migration lock");
}

/** How many advisory locks sessions of this database hold, the migrator's and the Dev lock among them. */
export async function advisoryLocksHeld(driver: Driver): Promise<number> {
  const { rows } = await driver.query(
    "select count(*)::int as n from pg_locks where locktype = 'advisory' and granted and database = (select oid from pg_database where datname = current_database())",
  );
  return Number(rows[0]?.["n"]);
}

/** The advisory-lock requests queued in this database; other databases' tests don't count. */
async function queuedAdvisoryLocks(driver: Driver): Promise<number> {
  const { rows } = await driver.query(
    "select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted and database = (select oid from pg_database where datname = current_database())",
  );
  return Number(rows[0]?.["n"]);
}

/**
 * Holds the migration lock in a session of its own, starts `contender`, and waits until it tries
 * for the lock. Reports whether it finished and how many lock requests queued while the lock was
 * held, then releases the lock and awaits the contender's result.
 */
export function whileMigrationLockHeld<T>(
  driver: Driver,
  contender: () => Promise<T>,
): Promise<{ readonly finishedWhileHeld: boolean; readonly queued: number; readonly result: T }> {
  return driver.session(async (holder) => {
    await acquireMigrationLock(holder);
    const holderPid = await backendPid(holder);
    let finishedWhileHeld = false;
    const running = contender().finally(() => {
      finishedWhileHeld = true;
    });
    // A contender that rejects while we wait must not surface as unhandled; `await running` rethrows it.
    const settled = running.catch(() => {});
    let queued = 0;
    let held = false;
    try {
      await untilMigrationLockAttempted(driver, { holderPid, gaveUp: () => finishedWhileHeld });
      queued = await queuedAdvisoryLocks(driver);
      held = finishedWhileHeld;
    } finally {
      await holder.query("select pg_advisory_unlock_all()");
      await settled;
    }
    return { finishedWhileHeld: held, queued, result: await running };
  });
}
