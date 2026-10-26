import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import postgres, { type Sql } from "postgres";
import { afterAll, afterEach, beforeAll } from "vitest";
import type { Connect, Driver } from "../../runtime/ports/index.ts";
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
 * The test server's URL, from `DATABASE_URL`. The only place a test reads it, so a missing server
 * always fails with the `test-db.ts` hint rather than `Invalid URL`.
 */
export function testServerUrl(): string {
  const serverUrl = process.env["DATABASE_URL"];
  if (serverUrl === undefined || serverUrl === "") {
    throw new Error(missingServerUrl);
  }
  return serverUrl;
}

/**
 * Creates a fresh database on `DATABASE_URL`'s server before the test file and drops it after.
 * Every test in the file shares it, so give each test its own table names.
 */
export function useTestDatabase(): TestDatabase {
  const serverUrl = testServerUrl();
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
