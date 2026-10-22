import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import type { MigrationFile, MigrationSource } from "../ports/index.ts";
import { migrate } from "./migrate.ts";

const db = useTestDatabase();

const CREATE_USERS: MigrationFile = {
  filename: "000001-create-users.sql",
  content: `--! Previous: -
--! Hash: sha256:a374e922d1cfedd4e106dea663783b3ca2ec1b2d221d5c16402100e7d2a08118

create table users (id integer primary key, name text not null);
`,
};

function source(...files: MigrationFile[]): MigrationSource {
  return { list: () => Promise.resolve(files) };
}

async function markDev(schema: string): Promise<void> {
  await db.driver.execute(
    `create schema if not exists ${schema}; create table ${schema}.current (hash text not null, applied_at timestamptz not null default now()); insert into ${schema}.current (hash) values ('sha256:x');`,
  );
}

beforeEach(async () => {
  await db.driver.execute(
    "drop schema if exists smonn_db cascade; drop schema public cascade; create schema public;",
  );
});

describe("migrate's tracking schema and Dev database guard", () => {
  it("records into a tracking schema of the caller's choosing", async () => {
    await db.driver.execute("drop schema if exists app_tracking cascade");

    await migrate({
      driver: db.driver,
      source: source(CREATE_USERS),
      trackingSchema: "app_tracking",
    });

    expect(
      (await db.driver.query("select filename from app_tracking.migrations order by sequence"))
        .rows,
    ).toStrictEqual([{ filename: CREATE_USERS.filename }]);
    expect(
      (await db.driver.query("select 1 from pg_namespace where nspname = 'smonn_db'")).rows,
    ).toStrictEqual([]);
  });

  it("refuses a Dev database that has Committed migrations pending", async () => {
    await markDev("smonn_db");

    await expect(migrate({ driver: db.driver, source: source(CREATE_USERS) })).rejects.toThrow(
      '"smonn_db"."current" holds a row, so this is a Dev database',
    );
    expect(
      (await db.driver.query("select 1 from pg_class where relname = 'users'")).rows,
    ).toStrictEqual([]);
  });

  it("checks the configured tracking schema's current table", async () => {
    await db.driver.execute("drop schema if exists app_tracking cascade");
    await markDev("app_tracking");

    await expect(
      migrate({ driver: db.driver, source: source(CREATE_USERS), trackingSchema: "app_tracking" }),
    ).rejects.toThrow('"app_tracking"."current" holds a row');
  });

  it("does nothing on a Dev database with nothing pending", async () => {
    await migrate({ driver: db.driver, source: source(CREATE_USERS) });
    await markDev("smonn_db");

    const result = await migrate({ driver: db.driver, source: source(CREATE_USERS) });

    expect(result).toStrictEqual({ applied: [] });
  });

  it("migrates when the current table is empty", async () => {
    await db.driver.execute(
      "create schema smonn_db; create table smonn_db.current (hash text not null, applied_at timestamptz not null default now());",
    );

    const result = await migrate({ driver: db.driver, source: source(CREATE_USERS) });

    expect(result).toStrictEqual({ applied: [CREATE_USERS.filename] });
  });

  it.each(["AppTracking", "app tracking", 'app"tracking', 'x"; drop schema public cascade; --'])(
    "records into a tracking schema named %j, case-sensitively",
    async (name) => {
      await db.driver.execute(`drop schema if exists "${name.replaceAll('"', '""')}" cascade`);

      await migrate({ driver: db.driver, source: source(CREATE_USERS), trackingSchema: name });

      expect(
        (await db.driver.query("select nspname from pg_namespace where nspname = $1", [name])).rows,
      ).toStrictEqual([{ nspname: name }]);
      expect(
        (await db.driver.query("select 1 from pg_class where relname = 'users'")).rows,
      ).toHaveLength(1);
    },
  );

  it("guards a mixed-case tracking schema's current table", async () => {
    await db.driver.execute('drop schema if exists "AppTracking" cascade');
    await markDev('"AppTracking"');

    await expect(
      migrate({ driver: db.driver, source: source(CREATE_USERS), trackingSchema: "AppTracking" }),
    ).rejects.toThrow('"AppTracking"."current" holds a row');
  });

  it.each([
    ["", "must not be empty"],
    ["a\0b", "must not contain a NUL byte"],
    ["a".repeat(64), "at most 63 bytes"],
    ["é".repeat(32), "at most 63 bytes"],
    ["pg_tracking", 'must not start with "pg_"'],
  ])("rejects the tracking schema name %j", async (name, message) => {
    await expect(
      migrate({ driver: db.driver, source: source(CREATE_USERS), trackingSchema: name }),
    ).rejects.toThrow(message);
  });

  it("accepts a 63-byte tracking schema name", async () => {
    const name = "é".repeat(31) + "a";

    const result = await migrate({
      driver: db.driver,
      source: source(CREATE_USERS),
      trackingSchema: name,
    });

    expect(result).toStrictEqual({ applied: [CREATE_USERS.filename] });
  });
});
