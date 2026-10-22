import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll } from "vitest";
import type { Driver } from "../../runtime/ports/index.ts";
import { postgresJsDriver } from "./driver.ts";

export type TestDatabase = {
  readonly driver: Driver;
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
  const sql = postgres(url.href, { onnotice: ignoreNotice });

  beforeAll(async () => {
    await admin.unsafe(`create database ${name}`).catch((error: unknown) => {
      throw explainConnectionError(error, serverUrl);
    });
  });
  afterAll(async () => {
    await sql.end();
    await admin.unsafe(`drop database ${name} with (force)`).catch((error: unknown) => {
      throw explainConnectionError(error, serverUrl);
    });
    await admin.end();
  });

  return { driver: postgresJsDriver(sql) };
}
