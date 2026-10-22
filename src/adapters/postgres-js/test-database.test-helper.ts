import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll } from "vitest";
import type { Connect, Driver } from "../../runtime/ports/index.ts";
import { postgresJsConnect } from "./connect.ts";
import { postgresJsDriver } from "./driver.ts";
import { postgresJsConnection, postgresJsTypes } from "./value-types.ts";

export type TestDatabase = {
  readonly name: string;
  readonly driver: Driver;
  /**
   * Opens a pool of its own on this database, for a test that breaks a connection. postgres.js
   * hands a connection whose backend ended mid-statement a stale error and never ends it (#154).
   */
  readonly ownPool: () => Driver;
  /** Opens another database on the same server; the caller closes it. */
  readonly connect: Connect;
};

const ignoreNotice = (): void => {};

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
 * Creates a fresh database on `DATABASE_URL`'s server before the test file and drops it after.
 * Every test in the file shares it, so give each test its own table names.
 */
export function useTestDatabase(): TestDatabase {
  const serverUrl = process.env["DATABASE_URL"];
  if (serverUrl === undefined || serverUrl === "") {
    throw new Error("Set DATABASE_URL to a Postgres 18 server, such as the one compose.yaml runs");
  }
  const name = `smonn_db_test_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;

  const admin = postgres(serverUrl, { max: 1, onnotice: ignoreNotice });
  const client = (): Sql =>
    postgres(url.href, {
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
  afterAll(async () => {
    await Promise.all([sql.end(), ...ownPools.map((pool) => pool.end({ timeout: 0 }))]);
    await admin.unsafe(`drop database ${name} with (force)`).catch((error: unknown) => {
      throw explainConnectionError(error, serverUrl);
    });
    await admin.end();
  });

  return {
    name,
    driver: postgresJsDriver(sql),
    ownPool: () => {
      const pool = client();
      ownPools.push(pool);
      return postgresJsDriver(pool);
    },
    connect: postgresJsConnect(serverUrl, { onnotice: ignoreNotice }),
  };
}

/**
 * Waits until another backend in this database runs a statement containing `fragment`, then
 * terminates it. Other test files' databases are out of reach, and a backend that ends first
 * doesn't count as terminated.
 */
export async function terminateBackendRunning(driver: Driver, fragment: string): Promise<void> {
  const { rows } = await driver.query(
    "select pg_terminate_backend(pid) as terminated from pg_stat_activity where pid <> pg_backend_pid() and datname = current_database() and state = 'active' and strpos(query, $1) > 0",
    [fragment],
  );
  if (!rows.some((row) => row.terminated === true)) {
    await setTimeout(10);
    await terminateBackendRunning(driver, fragment);
  }
}
