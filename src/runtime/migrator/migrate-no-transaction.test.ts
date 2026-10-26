import { beforeEach, describe, expect, it } from "vitest";
import {
  backendRunning,
  useTestDatabase,
} from "../../adapters/postgres-js/test-database.test-helper.ts";
import { writeMigration } from "../internal/index.ts";
import type { MigrationFile, MigrationSource } from "../ports/index.ts";
import { migrate } from "./migrate.ts";

const db = useTestDatabase();

const CREATE_USERS = await writeMigration(
  "000001-create-users.sql",
  undefined,
  "create table users (id integer primary key, name text not null);\ninsert into users values (1, 'Ada'), (2, 'Ada');\n",
);
const INDEX_NAME = await writeMigration(
  "000002-index-name.sql",
  CREATE_USERS.hash,
  "create index concurrently users_name on users (name);\n",
  { noTransaction: true },
);
const ADD_EMAIL = await writeMigration(
  "000003-add-email.sql",
  INDEX_NAME.hash,
  "alter table users add column email text;\n",
);

function source(...files: MigrationFile[]): MigrationSource {
  return { list: () => Promise.resolve(files) };
}

async function queryRows(sql: string): Promise<unknown> {
  return (await db.driver.query(sql)).rows;
}

/** Whether another connection can take the migrator's lock, so the failed run released it. */
function lockIsFree(): Promise<boolean> {
  return db.driver.session(async (session) => {
    const { rows } = await session.query("select pg_try_advisory_lock(76666326447283) as locked");
    return rows[0]?.["locked"] === true;
  });
}

const STATUSES = "select filename, status, error from smonn_db.migrations order by sequence";
const applied = (filename: string): unknown => ({ filename, status: "applied", error: null });

beforeEach(async () => {
  await db.driver.execute(
    "drop schema if exists smonn_db cascade; drop schema public cascade; create schema public;",
  );
});

describe("migrate a no-transaction file (ADR-0020)", () => {
  it("runs CREATE INDEX CONCURRENTLY outside a transaction, then the next file, and records both applied", async () => {
    const result = await migrate({
      driver: db.driver,
      source: source(CREATE_USERS, INDEX_NAME, ADD_EMAIL),
    });

    expect(result.applied).toStrictEqual([
      CREATE_USERS.filename,
      INDEX_NAME.filename,
      ADD_EMAIL.filename,
    ]);
    expect(
      await queryRows(
        "select indisvalid from pg_index where indexrelid = 'public.users_name'::regclass",
      ),
    ).toStrictEqual([{ indisvalid: true }]);
    expect(await queryRows(STATUSES)).toStrictEqual([
      applied(CREATE_USERS.filename),
      applied(INDEX_NAME.filename),
      applied(ADD_EMAIL.filename),
    ]);
  });

  it("records the row as started before the statement runs, in its own commit", async () => {
    await migrate({ driver: db.driver, source: source(CREATE_USERS) });
    let migrating: Promise<unknown> = Promise.resolve();
    let seen: unknown;

    // A share lock on users holds the CONCURRENTLY build after the row was written.
    await db.driver.transaction(async (holder) => {
      await holder.execute("lock table users in share mode");
      migrating = migrate({ driver: db.driver, source: source(CREATE_USERS, INDEX_NAME) });
      await backendRunning(db.driver, "create index concurrently");
      seen = await queryRows("select status from smonn_db.migrations where sequence = 2");
    });
    await migrating;

    expect(seen).toStrictEqual([{ status: "started" }]);
    expect(await queryRows(STATUSES)).toStrictEqual([
      applied(CREATE_USERS.filename),
      applied(INDEX_NAME.filename),
    ]);
  });

  it("marks the row failed with Postgres's message, rethrows, and refuses the next run", async () => {
    const duplicate = await writeMigration(
      "000002-unique-name.sql",
      CREATE_USERS.hash,
      "create unique index concurrently users_name on users (name);\n",
      { noTransaction: true },
    );
    const files = source(CREATE_USERS, duplicate);

    const failure = migrate({ driver: db.driver, source: files });

    await expect(failure).rejects.toThrow(/could not create unique index "users_name"/u);
    expect(await queryRows(STATUSES)).toStrictEqual([
      applied(CREATE_USERS.filename),
      {
        filename: duplicate.filename,
        status: "failed",
        error: expect.stringContaining('could not create unique index "users_name"') as unknown,
      },
    ]);
    await expect(migrate({ driver: db.driver, source: files })).rejects.toThrow(
      `${duplicate.filename} is recorded as failed: could not create unique index "users_name"`,
    );
    expect(await lockIsFree()).toBe(true);
  });

  it("fails a file of two statements with 25001, which Postgres enforces", async () => {
    const two = await writeMigration(
      "000002-two-indexes.sql",
      CREATE_USERS.hash,
      "create index concurrently a on users (id);\ncreate index concurrently b on users (name);\n",
      { noTransaction: true },
    );

    const failure = migrate({ driver: db.driver, source: source(CREATE_USERS, two) });

    await expect(failure).rejects.toMatchObject({ code: "25001" });
    expect(await queryRows(STATUSES)).toStrictEqual([
      applied(CREATE_USERS.filename),
      {
        filename: two.filename,
        status: "failed",
        error: expect.stringContaining("cannot run inside a transaction block") as unknown,
      },
    ]);
  });

  it("rolls back a transactional file that holds CONCURRENTLY without the header", async () => {
    const bare = await writeMigration(
      "000002-bare.sql",
      CREATE_USERS.hash,
      "create index concurrently users_name on users (name);\n",
    );

    const failure = migrate({ driver: db.driver, source: source(CREATE_USERS, bare) });

    await expect(failure).rejects.toMatchObject({ code: "25001" });
    expect(await queryRows(STATUSES)).toStrictEqual([applied(CREATE_USERS.filename)]);
  });

  it("refuses a file whose header was added after it was hashed", async () => {
    const without = await writeMigration(
      "000002-index-name.sql",
      CREATE_USERS.hash,
      "create index concurrently users_name on users (name);\n",
    );
    const tampered = {
      filename: without.filename,
      content: without.content.replace("\n\n", "\n--! no-transaction\n\n"),
    };

    const failure = migrate({ driver: db.driver, source: source(CREATE_USERS, tampered) });

    await expect(failure).rejects.toThrow(
      `${without.filename}: --! Hash says ${without.hash} but the body hashes to ${INDEX_NAME.hash}`,
    );
  });
});
