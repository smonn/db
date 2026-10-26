import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import type { MigrationFile, MigrationSource } from "../ports/index.ts";
import { migrate } from "./migrate.ts";

const db = useTestDatabase();

const HASH_1 = "sha256:a374e922d1cfedd4e106dea663783b3ca2ec1b2d221d5c16402100e7d2a08118";
const HASH_2 = "sha256:02d58be49c96c8a3b738b9044e9ba99937f6b36424391dcf5acf2e34e3ec4ec7";

const CREATE_USERS: MigrationFile = {
  filename: "000001-create-users.sql",
  content: `--! Previous: -
--! Hash: ${HASH_1}

create table users (id integer primary key, name text not null);
`,
};

const ADD_EMAIL: MigrationFile = {
  filename: "000002-add-email.sql",
  content: `--! Previous: ${HASH_1}
--! Hash: ${HASH_2}

alter table users add column email text;
insert into users (id, name) values (1, 'Ada');
`,
};

function source(...files: MigrationFile[]): MigrationSource {
  return { list: () => Promise.resolve(files) };
}

const V01_TABLE = `create schema smonn_db;
create table smonn_db.migrations (
  sequence integer primary key,
  filename text not null,
  hash text not null unique,
  previous_hash text references smonn_db.migrations (hash),
  applied_at timestamptz not null default now()
);`;

async function statuses(): Promise<unknown> {
  const { rows } = await db.driver.query(
    "select filename, status, error from smonn_db.migrations order by sequence",
  );
  return rows;
}

beforeEach(async () => {
  await db.driver.execute(
    'drop schema if exists smonn_db, tracking, "Mixed Case" cascade; drop schema public cascade; create schema public;',
  );
});

describe("migrate tracking row status (ADR-0020)", () => {
  it("records a transactional file as applied with no error", async () => {
    await migrate({ driver: db.driver, source: source(CREATE_USERS) });

    expect(await statuses()).toStrictEqual([
      { filename: CREATE_USERS.filename, status: "applied", error: null },
    ]);
  });

  it("adds status and error to a v0.1 tracking table and keeps its rows applied", async () => {
    await db.driver.execute(
      `${V01_TABLE}
create table users (id integer primary key, name text not null);
insert into smonn_db.migrations (sequence, filename, hash) values (1, '${CREATE_USERS.filename}', '${HASH_1}');`,
    );

    const result = await migrate({
      driver: db.driver,
      source: source(CREATE_USERS, ADD_EMAIL),
    });

    expect(result).toStrictEqual({ applied: [ADD_EMAIL.filename] });
    expect(await statuses()).toStrictEqual([
      { filename: CREATE_USERS.filename, status: "applied", error: null },
      { filename: ADD_EMAIL.filename, status: "applied", error: null },
    ]);
  });

  it("refuses when the last row is started, naming the file and the SQL fix", async () => {
    await migrate({ driver: db.driver, source: source(CREATE_USERS) });
    await db.driver.execute(
      `insert into smonn_db.migrations (sequence, filename, hash, previous_hash, status) values (2, '${ADD_EMAIL.filename}', '${HASH_2}', '${HASH_1}', 'started')`,
    );

    const failure = migrate({ driver: db.driver, source: source(CREATE_USERS, ADD_EMAIL) });

    await expect(failure).rejects.toThrow(
      `${ADD_EMAIL.filename} is recorded as started\nClean up what it left, then delete its row to retry it:\n  delete from "smonn_db"."migrations" where sequence = 2;\nOr, when the statement did finish, mark it applied:\n  update "smonn_db"."migrations" set status = 'applied', error = null where sequence = 2;`,
    );
  });

  it("refuses when the last row is failed, naming the stored error, and runs nothing", async () => {
    await migrate({ driver: db.driver, source: source(CREATE_USERS) });
    await db.driver.execute(
      `insert into smonn_db.migrations (sequence, filename, hash, previous_hash, status, error) values (2, '${ADD_EMAIL.filename}', '${HASH_2}', '${HASH_1}', 'failed', 'index build deadlocked')`,
    );

    const failure = migrate({ driver: db.driver, source: source(CREATE_USERS, ADD_EMAIL) });

    await expect(failure).rejects.toThrow(
      `${ADD_EMAIL.filename} is recorded as failed: index build deadlocked\n`,
    );
    expect(
      (await db.driver.query("select 1 from pg_attribute where attname = 'email'")).rows,
    ).toStrictEqual([]);
  });

  it.each(["tracking", "Mixed Case"])(
    "quotes the custom tracking schema %j in the SQL fix",
    async (schema) => {
      const quoted = `"${schema}"`;
      await migrate({ driver: db.driver, source: source(CREATE_USERS), trackingSchema: schema });
      await db.driver.execute(
        `insert into ${quoted}.migrations (sequence, filename, hash, previous_hash, status) values (2, '${ADD_EMAIL.filename}', '${HASH_2}', '${HASH_1}', 'started')`,
      );

      const failure = migrate({
        driver: db.driver,
        source: source(CREATE_USERS, ADD_EMAIL),
        trackingSchema: schema,
      });

      await expect(failure).rejects.toThrow(
        `delete from ${quoted}."migrations" where sequence = 2;\nOr, when the statement did finish, mark it applied:\n  update ${quoted}."migrations" set status = 'applied', error = null where sequence = 2;`,
      );
    },
  );

  it("doesn't refuse over a failed row that an applied row follows", async () => {
    await migrate({ driver: db.driver, source: source(CREATE_USERS, ADD_EMAIL) });
    await db.driver.execute(
      "update smonn_db.migrations set status = 'failed', error = 'old failure' where sequence = 1",
    );

    const result = await migrate({
      driver: db.driver,
      source: source(CREATE_USERS, ADD_EMAIL),
    });

    expect(result).toStrictEqual({ applied: [] });
  });

  it("retries once the row is deleted", async () => {
    await migrate({ driver: db.driver, source: source(CREATE_USERS) });
    await db.driver.execute(
      `insert into smonn_db.migrations (sequence, filename, hash, previous_hash, status) values (2, '${ADD_EMAIL.filename}', '${HASH_2}', '${HASH_1}', 'started')`,
    );
    await db.driver.execute("delete from smonn_db.migrations where sequence = 2");

    const result = await migrate({
      driver: db.driver,
      source: source(CREATE_USERS, ADD_EMAIL),
    });

    expect(result).toStrictEqual({ applied: [ADD_EMAIL.filename] });
  });
});
