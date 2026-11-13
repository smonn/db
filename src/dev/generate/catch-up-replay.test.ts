import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { defineDatabase, defineTable } from "../../runtime/definition/index.ts";
import {
  currentHash,
  parseCurrent,
  parseMigration,
  readCommitted,
  writeMigration,
} from "../../runtime/internal/index.ts";
import { commit } from "./commit.ts";
import { generate, type GenerateResult } from "./generate.ts";
import { memoryFileSystem, type MemoryFileSystem } from "./memory-file-system.test-helper.ts";

const db = useTestDatabase();

const MIGRATIONS = "db/migrations";
const CURRENT = `${MIGRATIONS}/current.sql`;

const users = defineDatabase({ public: { users: defineTable((c) => ({ id: c.text() })) } });
const withEmail = defineDatabase({
  public: { users: defineTable((c) => ({ id: c.text(), email: c.text() })) },
});
const withRequiredEmail = defineDatabase({
  public: { users: defineTable((c) => ({ id: c.text(), email: c.text().notNull() })) },
});

beforeEach(async () => {
  await db.driver.execute(
    "drop schema if exists smonn_db cascade; drop schema public cascade; create schema public;",
  );
});

function generateWith(
  fileSystem: MemoryFileSystem,
  definition: typeof users,
): Promise<GenerateResult> {
  return generate({
    driver: db.driver,
    connect: db.connect,
    fileSystem,
    definition,
    migrations: MIGRATIONS,
  });
}

async function commitAs(fileSystem: MemoryFileSystem, slug: string): Promise<void> {
  await commit({ driver: db.driver, fileSystem, migrations: MIGRATIONS, slug, accept: [] });
}

async function hasJunk(): Promise<boolean> {
  const { rows } = await db.driver.query("select to_regclass('public.junk') is not null as found");
  return rows[0]?.["found"] === true;
}

/** A Dev database holding one Committed migration, no Current migration, and a table to keep. */
async function committedUsers(definition = users): Promise<MemoryFileSystem> {
  const fileSystem = memoryFileSystem();
  await generateWith(fileSystem, definition);
  await commitAs(fileSystem, "create-users");
  await db.driver.execute("create table public.junk (id int)");
  return fileSystem;
}

async function pull(
  fileSystem: MemoryFileSystem,
  filename: string,
  body: string,
  options?: { readonly noTransaction: boolean },
): Promise<void> {
  const chain = (await readCommitted(fileSystem, MIGRATIONS)).map((file) => parseMigration(file));
  const pulled = await writeMigration(filename, chain.at(-1)?.hash, body, options);
  fileSystem.files.set(`${MIGRATIONS}/${filename}`, pulled.content);
}

async function recordedFilenames(): Promise<unknown[]> {
  const { rows } = await db.driver.query(
    "select filename from smonn_db.migrations order by sequence",
  );
  return rows.map((row) => row["filename"]);
}

async function recordedCurrent(): Promise<unknown[]> {
  const { rows } = await db.driver.query("select hash from smonn_db.current");
  return rows.map((row) => row["hash"]);
}

describe("replaying new files into a Dev database with no Current migration recorded", () => {
  it("applies a pulled Committed file as written, records it, and keeps the data", async () => {
    const fileSystem = await committedUsers();
    await pull(
      fileSystem,
      "000002-add-email.sql",
      "alter table public.users add column email text;\n",
    );

    const result = await generateWith(fileSystem, withEmail);

    expect(result.devDatabase).toStrictEqual({
      kind: "replayed",
      files: ["000002-add-email.sql"],
      hazards: [],
    });
    expect(await hasJunk()).toBe(true);
    expect(await recordedFilenames()).toStrictEqual([
      "000001-create-users.sql",
      "000002-add-email.sql",
    ]);
    expect(await recordedCurrent()).toStrictEqual([]);
    expect((await generateWith(fileSystem, withEmail)).devDatabase).toStrictEqual({ kind: "none" });
  });

  it("applies a new Current migration, records its hash, and keeps the data", async () => {
    const fileSystem = await committedUsers();

    const result = await generateWith(fileSystem, withEmail);

    expect(result.devDatabase).toStrictEqual({
      kind: "replayed",
      files: ["current.sql"],
      hazards: [],
    });
    expect(await hasJunk()).toBe(true);
    const { body } = await parseCurrent(fileSystem.files.get(CURRENT)!);
    expect(await recordedCurrent()).toStrictEqual([await currentHash(body)]);
    await commitAs(fileSystem, "add-email");
    expect(fileSystem.files.has(`${MIGRATIONS}/000002-add-email.sql`)).toBe(true);
  });

  it("applies a pulled file's data-loss step and returns its Hazard", async () => {
    const fileSystem = await committedUsers(withEmail);
    const drop = "alter table public.users drop column email;";
    await pull(fileSystem, "000002-drop-email.sql", `-- hazard: data_loss\n${drop}\n`);

    const result = await generateWith(fileSystem, users);

    expect(result.devDatabase).toStrictEqual({
      kind: "replayed",
      files: ["000002-drop-email.sql"],
      hazards: [{ file: "000002-drop-email.sql", kind: "data_loss", statement: drop }],
    });
    const { rows } = await db.driver.query(
      "select column_name from information_schema.columns where table_name = 'users'",
    );
    expect(rows).toStrictEqual([{ column_name: "id" }]);
  });

  it("rolls a failed file back, leaves the Dev database as it was, and names reset", async () => {
    const fileSystem = await committedUsers();
    await db.driver.execute("insert into public.users (id) values ('kept')");
    await pull(
      fileSystem,
      "000002-require-email.sql",
      "alter table public.users add column email text not null;\n",
    );

    const failure = generateWith(fileSystem, withRequiredEmail);

    await expect(failure).rejects.toThrow(
      /^the Dev database didn't catch up, so it was left as it was: 000002-require-email\.sql: .+; run smonndb reset to rebuild it from the files$/u,
    );
    await expect(failure).rejects.toHaveProperty(
      "cause.message",
      expect.stringMatching(/^000002-require-email\.sql: /u),
    );

    expect(await hasJunk()).toBe(true);
    expect(await recordedFilenames()).toStrictEqual(["000001-create-users.sql"]);
    expect(await recordedCurrent()).toStrictEqual([]);
    const { rows } = await db.driver.query("select * from public.users");
    expect(rows).toStrictEqual([{ id: "kept" }]);
  });

  it("diffs, naming the file, when a pulled file can't run in a transaction", async () => {
    const fileSystem = await committedUsers();
    await pull(fileSystem, "000002-noop.sql", "select 1;\n", { noTransaction: true });

    expect((await generateWith(fileSystem, users)).devDatabase).toStrictEqual({
      kind: "diffed",
      skipped: ["000002-noop.sql"],
      hazards: [{ kind: "data_loss", statement: 'drop table "public"."junk";' }],
    });
    expect(await hasJunk()).toBe(false);
    expect(await recordedFilenames()).toStrictEqual(["000001-create-users.sql", "000002-noop.sql"]);
  });

  it("diffs, naming current.sql, when the Current migration can't run in a transaction", async () => {
    const fileSystem = await committedUsers();
    fileSystem.files.set(CURRENT, "--! no-transaction\nselect 1;\n");

    expect((await generateWith(fileSystem, users)).devDatabase).toStrictEqual({
      kind: "diffed",
      skipped: ["current.sql"],
      hazards: [{ kind: "data_loss", statement: 'drop table "public"."junk";' }],
    });
    expect(await recordedCurrent()).toHaveLength(1);
  });
});
