import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { defineDatabase, defineTable } from "../../runtime/definition/index.ts";
import { writeMigration } from "../../runtime/internal/index.ts";
import { commit } from "./commit.ts";
import { generate } from "./generate.ts";
import { memoryFileSystem, type MemoryFileSystem } from "./memory-file-system.test-helper.ts";

const db = useTestDatabase();

const MIGRATIONS = "db/migrations";
const CURRENT = `${MIGRATIONS}/current.sql`;

const users = defineDatabase({ public: { users: defineTable((c) => ({ id: c.text() })) } });
const USERS_SQL = `create table "public"."users" (\n  "id" text\n);\n`;

async function generateInto(
  fileSystem: MemoryFileSystem,
  definition: typeof users = users,
): Promise<void> {
  await generate({
    driver: db.driver,
    connect: db.connect,
    fileSystem,
    definition,
    migrations: MIGRATIONS,
  });
}

const MISMATCH = `the Dev database's Committed migrations don't match the files in ${MIGRATIONS}; run generate first`;

/** Commits the users table, then generates an email column on top, so dev records one file. */
async function committedThenRegenerated(): Promise<MemoryFileSystem> {
  const fileSystem = memoryFileSystem();
  await generateInto(fileSystem);
  await commit({ driver: db.driver, fileSystem, migrations: MIGRATIONS, slug: "create-users" });
  await generateInto(
    fileSystem,
    defineDatabase({ public: { users: defineTable((c) => ({ id: c.text(), email: c.text() })) } }),
  );
  return fileSystem;
}

async function recorded(): Promise<unknown> {
  const { rows } = await db.driver.query(
    "select sequence, filename, hash, previous_hash from smonn_db.migrations order by sequence",
  );
  return rows;
}

async function currentRows(): Promise<number> {
  const { rows } = await db.driver.query("select hash from smonn_db.current");
  return rows.length;
}

beforeEach(async () => {
  await db.driver.execute(
    "drop schema if exists smonn_db cascade; drop schema public cascade; create schema public;",
  );
});

describe("commit", () => {
  it("freezes current.sql into the first Committed migration and records it in the Dev database", async () => {
    const fileSystem = memoryFileSystem();
    await generateInto(fileSystem);

    const result = await commit({
      driver: db.driver,
      fileSystem,
      migrations: MIGRATIONS,
      slug: "create-users",
    });

    const written = await writeMigration("000001-create-users.sql", undefined, USERS_SQL);
    expect(result).toStrictEqual({ path: `${MIGRATIONS}/000001-create-users.sql` });
    expect(fileSystem.files).toStrictEqual(new Map([[result.path, written.content]]));
    expect(await recorded()).toStrictEqual([
      { sequence: 1, filename: written.filename, hash: written.hash, previous_hash: null },
    ]);
    expect(await currentRows()).toBe(0);
  });

  it("chains the next Committed migration onto the tip", async () => {
    const fileSystem = memoryFileSystem();
    await generateInto(fileSystem);
    await commit({ driver: db.driver, fileSystem, migrations: MIGRATIONS, slug: "create-users" });
    await generateInto(
      fileSystem,
      defineDatabase({
        public: { users: defineTable((c) => ({ id: c.text(), email: c.text() })) },
      }),
    );

    const result = await commit({
      driver: db.driver,
      fileSystem,
      migrations: MIGRATIONS,
      slug: "add-email",
    });

    const first = await writeMigration("000001-create-users.sql", undefined, USERS_SQL);
    const second = await writeMigration(
      "000002-add-email.sql",
      first.hash,
      `alter table "public"."users" add column "email" text;\n`,
    );
    expect(fileSystem.files.get(result.path)).toBe(second.content);
    expect(await recorded()).toStrictEqual([
      { sequence: 1, filename: first.filename, hash: first.hash, previous_hash: null },
      { sequence: 2, filename: second.filename, hash: second.hash, previous_hash: first.hash },
    ]);
  });

  it("refuses a slug that isn't kebab-case, before touching anything", async () => {
    const fileSystem = memoryFileSystem();
    await generateInto(fileSystem);
    const before = new Map(fileSystem.files);

    await expect(
      commit({ driver: db.driver, fileSystem, migrations: MIGRATIONS, slug: "Create_Users" }),
    ).rejects.toThrow('slug "Create_Users" must be kebab-case, such as create-users');
    expect(fileSystem.files).toStrictEqual(before);
    expect(await currentRows()).toBe(1);
  });

  it("refuses when there is no current.sql", async () => {
    await expect(
      commit({
        driver: db.driver,
        fileSystem: memoryFileSystem(),
        migrations: MIGRATIONS,
        slug: "create-users",
      }),
    ).rejects.toThrow(`${CURRENT} doesn't exist; run generate first`);
  });

  it("refuses when the Dev database hasn't replayed current.sql as it reads now", async () => {
    const fileSystem = memoryFileSystem();
    await generateInto(fileSystem);
    fileSystem.files.set(CURRENT, `${fileSystem.files.get(CURRENT)}select 1;\n`);
    const before = new Map(fileSystem.files);

    await expect(
      commit({ driver: db.driver, fileSystem, migrations: MIGRATIONS, slug: "create-users" }),
    ).rejects.toThrow(
      `the Dev database hasn't replayed ${CURRENT} as it reads now; run generate first`,
    );
    expect(fileSystem.files).toStrictEqual(before);
    expect(await currentRows()).toBe(1);
  });

  it("hands the gate the body it reads and leaves everything as it was when the gate throws", async () => {
    const fileSystem = memoryFileSystem();
    await generateInto(fileSystem);
    const before = new Map(fileSystem.files);
    const bodies: string[] = [];

    await expect(
      commit({
        driver: db.driver,
        fileSystem,
        migrations: MIGRATIONS,
        slug: "create-users",
        gate: (body) => {
          bodies.push(body);
          throw new Error("gate says no");
        },
      }),
    ).rejects.toThrow("gate says no");
    expect(bodies).toStrictEqual([USERS_SQL]);
    expect(fileSystem.files).toStrictEqual(before);
    expect(await currentRows()).toBe(1);
  });

  it("refuses a Database without the tracking schema's current table", async () => {
    const fileSystem = memoryFileSystem();
    await generateInto(fileSystem);
    await db.driver.execute("drop schema smonn_db cascade");

    await expect(
      commit({ driver: db.driver, fileSystem, migrations: MIGRATIONS, slug: "create-users" }),
    ).rejects.toThrow(
      `the Dev database hasn't replayed ${CURRENT} as it reads now; run generate first`,
    );
  });

  it("refuses when the Dev database lags a pulled Committed migration", async () => {
    const fileSystem = memoryFileSystem();
    await generateInto(fileSystem);
    const pulled = await writeMigration("000001-pulled.sql", undefined, "select 1;\n");
    fileSystem.files.set(`${MIGRATIONS}/${pulled.filename}`, pulled.content);

    await expect(
      commit({ driver: db.driver, fileSystem, migrations: MIGRATIONS, slug: "create-users" }),
    ).rejects.toThrow(MISMATCH);
    expect(fileSystem.files.has(`${MIGRATIONS}/000002-create-users.sql`)).toBe(false);
  });

  it("refuses when the Dev database applied a different first migration than the file holds", async () => {
    const fileSystem = await committedThenRegenerated();
    const other = await writeMigration("000001-create-users.sql", undefined, "select 1;\n");
    fileSystem.files.set(`${MIGRATIONS}/${other.filename}`, other.content);
    const before = new Map(fileSystem.files);

    await expect(
      commit({ driver: db.driver, fileSystem, migrations: MIGRATIONS, slug: "add-email" }),
    ).rejects.toThrow(MISMATCH);
    expect(fileSystem.files).toStrictEqual(before);
  });

  it("refuses when the Dev database recorded a migration whose file is gone", async () => {
    const fileSystem = await committedThenRegenerated();
    fileSystem.files.delete(`${MIGRATIONS}/000001-create-users.sql`);
    const before = new Map(fileSystem.files);

    await expect(
      commit({ driver: db.driver, fileSystem, migrations: MIGRATIONS, slug: "add-email" }),
    ).rejects.toThrow(MISMATCH);
    expect(fileSystem.files).toStrictEqual(before);
  });

  it("refuses a broken hash chain, naming the file", async () => {
    const fileSystem = memoryFileSystem();
    await generateInto(fileSystem);
    const edited = await writeMigration("000001-a.sql", undefined, "select 1;\n");
    fileSystem.files.set(
      `${MIGRATIONS}/${edited.filename}`,
      edited.content.replace("select 1", "select 2"),
    );

    await expect(
      commit({ driver: db.driver, fileSystem, migrations: MIGRATIONS, slug: "create-users" }),
    ).rejects.toThrow("000001-a.sql: --! Hash says");
  });

  it("removes the file it wrote and keeps current.sql when recording fails", async () => {
    const fileSystem = memoryFileSystem();
    await generateInto(fileSystem);
    const before = new Map(fileSystem.files);
    await db.driver.execute(`
      create function smonn_db.refuse() returns trigger language plpgsql
        as $$ begin raise exception 'refused by test'; end $$;
      create trigger refuse before delete on smonn_db.current
        for each row execute function smonn_db.refuse();`);

    await expect(
      commit({ driver: db.driver, fileSystem, migrations: MIGRATIONS, slug: "create-users" }),
    ).rejects.toThrow("refused by test");
    expect(fileSystem.files).toStrictEqual(before);
    expect(await recorded()).toStrictEqual([]);
    expect(await currentRows()).toBe(1);
  });
});
