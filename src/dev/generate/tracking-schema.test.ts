import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { defineDatabase, defineTable } from "../../runtime/definition/index.ts";
import { sha256, writeMigration } from "../../runtime/internal/index.ts";
import { migrate } from "../../runtime/migrator/index.ts";
import { generate } from "./generate.ts";
import { filesIn, memoryFileSystem } from "./memory-file-system.test-helper.ts";

const db = useTestDatabase();

const TRACKING_SCHEMA = "AppTracking";

beforeEach(async () => {
  await db.driver.execute(
    `drop schema if exists smonn_db, "${TRACKING_SCHEMA}" cascade; drop schema public cascade; create schema public;`,
  );
});

describe("generate with a configured tracking schema", () => {
  it("keeps the marker and history where migrate reads them", async () => {
    const users = await writeMigration(
      "000001-create-users.sql",
      undefined,
      "create table public.users (id text not null);\n",
    );
    const posts = await writeMigration(
      "000002-create-posts.sql",
      users.hash,
      "create table public.posts (id text);\n",
    );
    const fileSystem = memoryFileSystem(filesIn("db/migrations", [users]));
    const options = {
      driver: db.driver,
      connect: db.connect,
      fileSystem,
      definition: defineDatabase({
        public: { users: defineTable((c) => ({ id: c.text().notNull(), email: c.text() })) },
      }),
      migrations: "db/migrations",
      trackingSchema: TRACKING_SCHEMA,
    };

    await generate(options);
    const result = await generate(options);

    expect(result.sql).toBe(`alter table "public"."users" add column "email" text;\n`);
    expect(
      (await db.driver.query(`select filename from "${TRACKING_SCHEMA}".migrations`)).rows,
    ).toStrictEqual([{ filename: "000001-create-users.sql" }]);
    expect(
      (await db.driver.query(`select hash from "${TRACKING_SCHEMA}".current`)).rows,
    ).toStrictEqual([{ hash: `sha256:${await sha256(String(result.sql))}` }]);
    expect(
      (await db.driver.query("select 1 from pg_namespace where nspname = 'smonn_db'")).rows,
    ).toStrictEqual([]);

    await expect(
      migrate({
        driver: db.driver,
        source: { list: () => Promise.resolve([users, posts]) },
        trackingSchema: TRACKING_SCHEMA,
      }),
    ).rejects.toThrow(`${TRACKING_SCHEMA}.current holds a row, so this is a Dev database`);
  });

  it("refuses a Database marked only in the default tracking schema", async () => {
    await db.driver.execute(`
      create schema smonn_db;
      create table smonn_db.current (hash text not null);
    `);

    await expect(
      generate({
        driver: db.driver,
        connect: db.connect,
        fileSystem: memoryFileSystem(),
        definition: defineDatabase({ public: {} }),
        migrations: "db/migrations",
        trackingSchema: TRACKING_SCHEMA,
      }),
    ).rejects.toThrow(
      `${db.name} isn't a Dev database: it has no ${TRACKING_SCHEMA}.current table`,
    );
  });

  it("rejects an invalid tracking schema name", async () => {
    await expect(
      generate({
        driver: db.driver,
        connect: db.connect,
        fileSystem: memoryFileSystem(),
        definition: defineDatabase({ public: {} }),
        migrations: "db/migrations",
        trackingSchema: "pg_tracking",
      }),
    ).rejects.toThrow('must not start with "pg_"');
  });
});
