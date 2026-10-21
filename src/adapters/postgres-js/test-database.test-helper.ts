import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll } from "vitest";
import type { Driver } from "../../runtime/ports/index.ts";
import { postgresJsDriver } from "./driver.ts";

export type TestDatabase = {
  readonly driver: Driver;
};

const ignoreNotice = (): void => {};

/** Creates a fresh database on `DATABASE_URL`'s server before the test file and drops it after. */
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
    await admin.unsafe(`create database ${name}`);
  });
  afterAll(async () => {
    await sql.end();
    await admin.unsafe(`drop database ${name} with (force)`);
    await admin.end();
  });

  return { driver: postgresJsDriver(sql) };
}
