import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import {
  DEFAULT_TRACKING_SCHEMA,
  trackingSchema,
  writeMigration,
} from "../../runtime/internal/index.ts";
import type { Driver, Queryable, Session } from "../../runtime/ports/index.ts";
import { filesIn, memoryFileSystem } from "./memory-file-system.test-helper.ts";
import { requireDevDatabase, reset } from "./reset.ts";

const db = useTestDatabase();

const MIGRATIONS = "db/migrations";
const CURRENT = `${MIGRATIONS}/current.sql`;

beforeEach(async () => {
  await db.driver.execute(
    "drop schema if exists smonn_db cascade; drop schema if exists ext cascade; drop schema public cascade; create schema public;",
  );
});

/** Runs every query and script of `driver`, in a session or a transaction, through `wrap`. */
function wrapped(driver: Driver, wrap: (queryable: Queryable) => Queryable): Driver {
  const wrapSession = (session: Session): Session => ({
    ...wrap(session),
    transaction: (fn) => session.transaction((tx) => fn(wrap(tx))),
  });
  return {
    ...wrapSession(driver),
    session: (fn) => driver.session((session) => fn(wrapSession(session))),
  };
}

/** Rejects a script that mentions `marker` with `reason`. */
function rejectingOn(driver: Driver, marker: string, reason: unknown): Driver {
  return wrapped(driver, (queryable) => ({
    query: (text, params) => queryable.query(text, params),
    execute: (script) =>
      script.includes(marker)
        ? // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- a rejection that isn't an Error is the point.
          Promise.reject(reason)
        : queryable.execute(script),
  }));
}

/**
 * Reports two extensions the database lacks, and records the scripts it runs. The drop of a
 * missing extension is a no-op, and the test database holds no extension that owns a schema.
 */
function reportingExtension(driver: Driver, scripts: string[]): Driver {
  return wrapped(driver, (queryable) => ({
    query: (text, params) =>
      text.includes("from pg_extension")
        ? Promise.resolve({ rows: [{ name: "fake ext" }, { name: "other" }], count: 2 })
        : queryable.query(text, params),
    execute: (script) => {
      scripts.push(script);
      return queryable.execute(script);
    },
  }));
}

async function rows(sql: string): Promise<unknown[]> {
  return (await db.driver.query(sql)).rows;
}

describe("requireDevDatabase", () => {
  it("names the database and says generate won't reset it", async () => {
    await db.driver.execute("create table public.precious (id int)");

    await expect(
      requireDevDatabase(db.driver, trackingSchema(DEFAULT_TRACKING_SCHEMA)),
    ).rejects.toThrow(
      `"${db.name}" isn't a Dev database: it has no "smonn_db"."current" table and isn't empty, so generate won't reset it`,
    );
  });

  it("says reset needs --erase when reset asks", async () => {
    await db.driver.execute("create table public.precious (id int)");

    await expect(
      requireDevDatabase(db.driver, trackingSchema(DEFAULT_TRACKING_SCHEMA), "reset"),
    ).rejects.toThrow("so reset needs --erase to wipe it");
  });
});

describe("reset", () => {
  it("drops each extension it finds, quoted, before it drops any schema", async () => {
    const scripts: string[] = [];
    const driver = reportingExtension(db.driver, scripts);

    await reset({ driver, fileSystem: memoryFileSystem(), migrations: MIGRATIONS, erase: true });

    expect(scripts.findIndex((script) => script.includes("drop extension"))).toBeLessThan(
      scripts.findIndex((script) => script.includes("drop schema")),
    );
    const drops = scripts.find((script) => script.includes("drop extension"));
    expect(drops).toContain('drop extension if exists "fake ext" cascade;');
    expect(drops).toContain('drop extension if exists "other" cascade;');
  });

  it("replays the files after a no-transaction file in one transaction", async () => {
    const first = await writeMigration("000001-a.sql", undefined, "create table public.a (n int);");
    const index = await writeMigration(
      "000002-index.sql",
      first.hash,
      "create index concurrently a_n on public.a (n);\n",
      { noTransaction: true },
    );
    const b = await writeMigration("000003-b.sql", index.hash, "create table public.b (n int);");
    const broken = await writeMigration("000004-broken.sql", b.hash, "select 1 / 0;");
    const fileSystem = memoryFileSystem(filesIn(MIGRATIONS, [first, index, b, broken]));

    await expect(reset({ driver: db.driver, fileSystem, migrations: MIGRATIONS })).rejects.toThrow(
      /^000004-broken\.sql: division by zero/u,
    );

    expect(
      await rows("select to_regclass('public.a') as a, to_regclass('public.b') as b"),
    ).toStrictEqual([{ a: "a", b: null }]);
  });

  it("names the file that failed and keeps the database's error as its cause", async () => {
    const fileSystem = memoryFileSystem({ [CURRENT]: "select 1 / 0;\n" });

    const attempt = reset({ driver: db.driver, fileSystem, migrations: MIGRATIONS });

    await expect(attempt).rejects.toThrow(/^current\.sql: division by zero/u);
    await expect(attempt).rejects.toHaveProperty("cause.message", "division by zero");
  });

  it("passes on a rejection that isn't an Error as it is", async () => {
    const fileSystem = memoryFileSystem({ [CURRENT]: "select 'non-error-marker';\n" });
    const driver = rejectingOn(db.driver, "non-error-marker", "plain string");

    await expect(reset({ driver, fileSystem, migrations: MIGRATIONS })).rejects.toBe(
      "plain string",
    );
  });
});
