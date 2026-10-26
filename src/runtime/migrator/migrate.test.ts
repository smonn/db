import { beforeEach, describe, expect, it } from "vitest";
import {
  terminateBackendRunning,
  useTestDatabase,
  whileMigrationLockHeld,
} from "../../adapters/postgres-js/test-database.test-helper.ts";
import { writeMigration } from "../internal/index.ts";
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

async function recorded(): Promise<unknown> {
  const { rows } = await db.driver.query(
    "select sequence, filename, hash, previous_hash from smonn_db.migrations order by sequence",
  );
  return rows;
}

beforeEach(async () => {
  await db.driver.execute(
    "drop schema if exists smonn_db cascade; drop schema public cascade; create schema public;",
  );
});

describe("migrate", () => {
  it("applies Committed migrations in sequence order and records each", async () => {
    const result = await migrate({ driver: db.driver, source: source(ADD_EMAIL, CREATE_USERS) });

    expect(result).toStrictEqual({
      applied: ["000001-create-users.sql", "000002-add-email.sql"],
    });
    expect((await db.driver.query("select id, name, email from users")).rows).toStrictEqual([
      { id: 1, name: "Ada", email: null },
    ]);
    expect(await recorded()).toStrictEqual([
      { sequence: 1, filename: "000001-create-users.sql", hash: HASH_1, previous_hash: null },
      { sequence: 2, filename: "000002-add-email.sql", hash: HASH_2, previous_hash: HASH_1 },
    ]);
  });

  it("applies nothing on a second run", async () => {
    await migrate({ driver: db.driver, source: source(CREATE_USERS, ADD_EMAIL) });
    const before = await recorded();

    const result = await migrate({ driver: db.driver, source: source(CREATE_USERS, ADD_EMAIL) });

    expect(result).toStrictEqual({ applied: [] });
    expect(await recorded()).toStrictEqual(before);
  });

  it("applies only the files added since the last run", async () => {
    await migrate({ driver: db.driver, source: source(CREATE_USERS) });

    const result = await migrate({ driver: db.driver, source: source(CREATE_USERS, ADD_EMAIL) });

    expect(result).toStrictEqual({ applied: ["000002-add-email.sql"] });
  });

  it("lets one of two parallel runs apply everything", async () => {
    const results = await Promise.all([
      migrate({ driver: db.driver, source: source(CREATE_USERS, ADD_EMAIL) }),
      migrate({ driver: db.driver, source: source(CREATE_USERS, ADD_EMAIL) }),
    ]);

    expect(results.map((result) => result.applied.length).toSorted((a, b) => a - b)).toStrictEqual([
      0, 2,
    ]);
  });

  it("waits for a held migration lock by polling, without queuing for it", async () => {
    const held = await whileMigrationLockHeld(db.driver, () =>
      migrate({ driver: db.driver, source: source(CREATE_USERS) }),
    );

    expect(held.queued).toBe(0);
    expect(held.result).toStrictEqual({ applied: ["000001-create-users.sql"] });
  });

  it("rolls back a failing file with its record and keeps the files before it", async () => {
    const body =
      "insert into users (id, name) values (1, 'Ada');\nalter table users add column name text;\n";
    const failing = await writeMigration("000002-add-name.sql", HASH_1, body);

    await expect(
      migrate({ driver: db.driver, source: source(CREATE_USERS, failing) }),
    ).rejects.toThrow('column "name" of relation "users" already exists');
    expect(await recorded()).toStrictEqual([
      { sequence: 1, filename: "000001-create-users.sql", hash: HASH_1, previous_hash: null },
    ]);
  });

  it("rejects with the statement's error when the backend ends mid-file", async () => {
    const sleeping = await writeMigration("000002-sleep.sql", HASH_1, "select pg_sleep(30);\n");

    const failed = migrate({ driver: db.ownPool(), source: source(CREATE_USERS, sleeping) });
    await Promise.all([
      expect(failed).rejects.toMatchObject({ code: "CONNECTION_CLOSED" }),
      terminateBackendRunning(db.driver, "pg_sleep(30)"),
    ]);
    expect(await recorded()).toStrictEqual([
      { sequence: 1, filename: "000001-create-users.sql", hash: HASH_1, previous_hash: null },
    ]);
  });

  it("refuses a file whose body doesn't match its Hash, before running anything", async () => {
    const edited: MigrationFile = {
      filename: ADD_EMAIL.filename,
      content: ADD_EMAIL.content.replace("'Ada'", "'Grace'"),
    };

    await expect(
      migrate({ driver: db.driver, source: source(CREATE_USERS, edited) }),
    ).rejects.toThrow(
      /^000002-add-email\.sql: --! Hash says sha256:02d58be4\w+ but the body hashes to sha256:\w+$/u,
    );
    const { rows } = await db.driver.query("select 1 from pg_namespace where nspname = 'smonn_db'");
    expect(rows).toStrictEqual([]);
  });

  it("refuses a file whose Previous isn't the prior file's Hash", async () => {
    const unlinked = withPrevious(ADD_EMAIL, `sha256:${"0".repeat(64)}`);

    await expect(
      migrate({ driver: db.driver, source: source(CREATE_USERS, unlinked) }),
    ).rejects.toThrow(`000002-add-email.sql: --! Previous should be ${HASH_1}, not sha256:000`);
  });

  it("refuses a first file that names a Previous", async () => {
    await expect(
      migrate({ driver: db.driver, source: source(withPrevious(CREATE_USERS, HASH_2)) }),
    ).rejects.toThrow(`000001-create-users.sql: --! Previous should be -, not ${HASH_2}`);
  });

  it("refuses a missing file, before running anything", async () => {
    const third = await writeMigration(
      "000003-add-age.sql",
      HASH_2,
      "alter table users add column age int;\n",
    );

    await expect(
      migrate({ driver: db.driver, source: source(CREATE_USERS, third) }),
    ).rejects.toThrow("000003-add-age.sql: sequence 2 is missing before it");
    const { rows } = await db.driver.query("select 1 from pg_namespace where nspname = 'smonn_db'");
    expect(rows).toStrictEqual([]);
  });

  it("refuses reordered files", async () => {
    const swapped = [
      { ...CREATE_USERS, filename: "000002-create-users.sql" },
      { ...ADD_EMAIL, filename: "000001-add-email.sql" },
    ];

    await expect(migrate({ driver: db.driver, source: source(...swapped) })).rejects.toThrow(
      `000001-add-email.sql: --! Previous should be -, not ${HASH_1}`,
    );
  });

  it("refuses a recorded migration that has no file", async () => {
    await migrate({ driver: db.driver, source: source(CREATE_USERS, ADD_EMAIL) });

    await expect(migrate({ driver: db.driver, source: source(CREATE_USERS) })).rejects.toThrow(
      `000002-add-email.sql: recorded as ${HASH_2} but has no file`,
    );
  });

  it("refuses a recorded file whose body changed and was rehashed", async () => {
    await migrate({ driver: db.driver, source: source(CREATE_USERS) });
    const rehashed = await writeMigration(
      CREATE_USERS.filename,
      undefined,
      "create table users (id integer primary key, name text);\n",
    );

    await expect(migrate({ driver: db.driver, source: source(rehashed) })).rejects.toThrow(
      new RegExp(
        `^000001-create-users\\.sql: recorded as ${HASH_1} but now hashes to sha256:\\w+$`,
        "u",
      ),
    );
  });

  it("refuses a file inserted before a recorded one, without running it", async () => {
    await migrate({ driver: db.driver, source: source(CREATE_USERS, ADD_EMAIL) });
    const inserted = await writeMigration(
      "000002-add-phone.sql",
      HASH_1,
      "alter table users add column phone text;\n",
    );
    const moved = await writeMigration(
      "000003-add-email.sql",
      inserted.hash,
      "alter table users add column email text;\n",
    );

    await expect(
      migrate({ driver: db.driver, source: source(CREATE_USERS, inserted, moved) }),
    ).rejects.toThrow(
      `000002-add-phone.sql: stands where the recorded 000002-add-email.sql (${HASH_2}) was`,
    );
    const { rows } = await db.driver.query(
      "select column_name from information_schema.columns where column_name = 'phone'",
    );
    expect(rows).toStrictEqual([]);
  });

  it("accepts a recorded file renamed to a new slug", async () => {
    await migrate({ driver: db.driver, source: source(CREATE_USERS) });
    const renamed = { ...CREATE_USERS, filename: "000001-make-users.sql" };

    const result = await migrate({ driver: db.driver, source: source(renamed, ADD_EMAIL) });

    expect(result).toStrictEqual({ applied: ["000002-add-email.sql"] });
  });

  describe("a Committed migration blocked by another object", () => {
    it("names the file and the blocker of a drop, and says the fix is a new migration (2BP01)", async () => {
      const failure = migrateBlocked("drop table users;\n");

      await expect(failure).rejects.toThrow(
        /^cannot drop table users because other objects depend on it:\n {2}view user_ids depends on table users\n000002-change\.sql rolled back\..*fix it in a new migration/su,
      );
      expect(await recorded()).toMatchObject([{ filename: "000001-users.sql" }]);
    });

    it("names the file and the blocker of a retype (0A000)", async () => {
      const failure = migrateBlocked("alter table users alter column id type varchar;\n");

      await expect(failure).rejects.toThrow(
        /^cannot alter type of a column used by a view or rule:\n {2}rule _RETURN on view user_ids depends on column "id"\n000002-change\.sql rolled back\..*fix it in a new migration/su,
      );
    });

    it("passes other SQL errors through", async () => {
      await expect(migrateBlocked("select * from nope;\n")).rejects.toThrow(
        /^relation "nope" does not exist$/u,
      );
    });
  });
});

/** Runs a first file that leaves a view on `users`, then a second whose `body` the view blocks. */
async function migrateBlocked(body: string): Promise<unknown> {
  const first = await writeMigration(
    "000001-users.sql",
    undefined,
    "create table users (id text not null);\ncreate view user_ids as select id from users;\n",
  );
  const second = await writeMigration("000002-change.sql", first.hash, body);
  return migrate({ driver: db.driver, source: source(first, second) });
}

function withPrevious(file: MigrationFile, previous: string): MigrationFile {
  return {
    ...file,
    content: file.content.replace(/--! Previous: .*/u, `--! Previous: ${previous}`),
  };
}
