import { beforeEach, describe, expect, it } from "vitest";
import {
  backendRunning,
  useTestDatabase,
} from "../../adapters/postgres-js/test-database.test-helper.ts";
import { writeMigration } from "../../runtime/internal/index.ts";
import { migrate } from "../../runtime/migrator/index.ts";
import type { DriverRow } from "../../runtime/ports/index.ts";
import { filesIn, memoryFileSystem } from "./memory-file-system.test-helper.ts";
import { reset } from "./reset.ts";

const db = useTestDatabase();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const MIGRATIONS = "db/migrations";

const CREATE_USERS = await writeMigration(
  "000001-create-users.sql",
  undefined,
  "create table public.users (id text);\ninsert into public.users values ('a'), ('a');\n",
);
const INDEX_ID = await writeMigration(
  "000002-index-id.sql",
  CREATE_USERS.hash,
  "create index concurrently users_id on public.users (id);\n",
  { noTransaction: true },
);
const ADD_EMAIL = await writeMigration(
  "000003-add-email.sql",
  INDEX_ID.hash,
  "alter table public.users add column email text;\n",
);

async function rows(sql: string): Promise<DriverRow[]> {
  return (await db.driver.query(sql)).rows;
}

const STATUSES = "select filename, status, error from smonn_db.migrations order by sequence";
const INDEX_VALID =
  "select indisvalid from pg_index where indexrelid = to_regclass('public.users_id')";
const applied = (filename: string): unknown => ({ filename, status: "applied", error: null });

beforeEach(async () => {
  await db.driver.execute(
    "drop schema if exists smonn_db cascade; drop schema public cascade; create schema public;",
  );
});

describe("reset around a no-transaction file (ADR-0020)", () => {
  it("replays a CONCURRENTLY index between two transactional files and records all three applied", async () => {
    const fileSystem = memoryFileSystem(filesIn(MIGRATIONS, [CREATE_USERS, INDEX_ID, ADD_EMAIL]));

    await reset({ driver: db.driver, fileSystem, migrations: MIGRATIONS });

    expect(await rows(INDEX_VALID)).toStrictEqual([{ indisvalid: true }]);
    expect(await rows("select email from public.users limit 0")).toStrictEqual([]);
    expect(await rows(STATUSES)).toStrictEqual([
      applied(CREATE_USERS.filename),
      applied(INDEX_ID.filename),
      applied(ADD_EMAIL.filename),
    ]);
  });

  it("names a failed no-transaction file, records it failed, and keeps the files before it", async () => {
    const unique = await writeMigration(
      "000002-unique-id.sql",
      CREATE_USERS.hash,
      "create unique index concurrently users_id on public.users (id);\n",
      { noTransaction: true },
    );
    const fileSystem = memoryFileSystem(filesIn(MIGRATIONS, [CREATE_USERS, unique]));

    await expect(reset({ driver: db.driver, fileSystem, migrations: MIGRATIONS })).rejects.toThrow(
      /^000002-unique-id\.sql: could not create unique index "users_id"/u,
    );

    expect(await rows(STATUSES)).toStrictEqual([
      applied(CREATE_USERS.filename),
      {
        filename: unique.filename,
        status: "failed",
        error: expect.stringContaining('could not create unique index "users_id"') as unknown,
      },
    ]);
  });

  it("holds the migrator's lock across the break, so a migrate waits, then finds nothing left", async () => {
    const fileSystem = memoryFileSystem(filesIn(MIGRATIONS, [CREATE_USERS, INDEX_ID]));
    const events: string[] = [];
    let resetting: Promise<unknown> = Promise.resolve();
    let migrating: Promise<unknown> = Promise.resolve();

    // A transaction with an older snapshot holds the CONCURRENTLY build, which runs after the break.
    await db.driver.session(async (holder) => {
      await holder.execute("begin isolation level repeatable read");
      await holder.query("select 1");
      resetting = reset({ driver: db.driver, fileSystem, migrations: MIGRATIONS }).then(() =>
        events.push("reset"),
      );
      await backendRunning(db.driver, "create index concurrently");
      migrating = migrate({
        driver: db.driver,
        source: { list: () => Promise.resolve([CREATE_USERS, INDEX_ID]) },
      }).then(() => events.push("migrate"));
      await sleep(250);
      expect(events).toStrictEqual([]);
      await holder.execute("commit");
    });
    await Promise.all([resetting, migrating]);

    expect(events).toStrictEqual(["reset", "migrate"]);
  });
});
