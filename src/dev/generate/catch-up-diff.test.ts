import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { defineDatabase, defineTable } from "../../runtime/definition/index.ts";
import { currentHash, parseCurrent } from "../../runtime/internal/index.ts";
import type { DriverRow } from "../../runtime/ports/index.ts";
import { commit } from "./commit.ts";
import { generate, type GenerateResult } from "./generate.ts";
import { memoryFileSystem, type MemoryFileSystem } from "./memory-file-system.test-helper.ts";

const db = useTestDatabase();

const MIGRATIONS = "db/migrations";
const CURRENT = `${MIGRATIONS}/current.sql`;

type Definition = Parameters<typeof generate>[0]["definition"];

const users = defineDatabase({ public: { users: defineTable((c) => ({ id: c.text() })) } });
const withEmail = defineDatabase({
  public: { users: defineTable((c) => ({ id: c.text(), email: c.text() })) },
});
const withMail = defineDatabase({
  public: { users: defineTable((c) => ({ id: c.text(), mail: c.text().renamedFrom("email") })) },
});

beforeEach(async () => {
  await db.driver.execute(
    "drop schema if exists smonn_db cascade; drop schema public cascade; create schema public;",
  );
});

function generateWith(
  fileSystem: MemoryFileSystem,
  definition: Definition,
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

async function rows(sql: string): Promise<DriverRow[]> {
  return (await db.driver.query(sql)).rows;
}

async function recordedFilenames(): Promise<unknown[]> {
  return (await rows("select filename from smonn_db.migrations order by sequence")).map(
    (row) => row["filename"],
  );
}

async function recordedCurrent(): Promise<unknown[]> {
  return (await rows("select hash from smonn_db.current")).map((row) => row["hash"]);
}

/** A Dev database that applied a Current migration creating `definition`, with one row in users. */
async function withCurrent(definition: Definition, row: string): Promise<MemoryFileSystem> {
  const fileSystem = memoryFileSystem();
  await generateWith(fileSystem, definition);
  await db.driver.execute(`insert into public.users values ${row}`);
  return fileSystem;
}

describe("diffing the Dev database against the Shadow when replay can't catch it up", () => {
  it("keeps the data across an edit to the Definition and records the new Current migration", async () => {
    const fileSystem = await withCurrent(users, "('kept')");

    const result = await generateWith(fileSystem, withEmail);

    expect(result.devDatabase).toStrictEqual({
      kind: "diffed",
      skipped: ["current.sql"],
      hazards: [],
    });
    expect(await rows("select id, email from public.users")).toStrictEqual([
      { id: "kept", email: null },
    ]);
    const { body } = await parseCurrent(fileSystem.files.get(CURRENT)!);
    expect(await recordedCurrent()).toStrictEqual([await currentHash(body)]);
    expect((await generateWith(fileSystem, withEmail)).devDatabase).toStrictEqual({ kind: "none" });
    await commitAs(fileSystem, "create-users");
    expect(await recordedFilenames()).toStrictEqual(["000001-create-users.sql"]);
  });

  it("runs a declared rename in the Dev database rather than dropping the column", async () => {
    const fileSystem = await withCurrent(withEmail, "('kept', 'a@b.c')");

    const result = await generateWith(fileSystem, withMail);

    expect(result.devDatabase).toStrictEqual({
      kind: "diffed",
      skipped: ["current.sql"],
      hazards: [
        {
          kind: "rename",
          statement: 'alter table "public"."users" rename column "email" to "mail";',
        },
      ],
    });
    expect(await rows("select id, mail from public.users")).toStrictEqual([
      { id: "kept", mail: "a@b.c" },
    ]);
  });

  it("keeps the data across a branch switch that removes a Committed file, and drops what it added", async () => {
    const fileSystem = memoryFileSystem();
    await generateWith(fileSystem, users);
    await commitAs(fileSystem, "create-users");
    await generateWith(fileSystem, withEmail);
    await commitAs(fileSystem, "add-email");
    await db.driver.execute("insert into public.users values ('kept', 'a@b.c')");
    fileSystem.files.delete(`${MIGRATIONS}/000002-add-email.sql`);

    const result = await generateWith(fileSystem, users);

    expect(result.devDatabase).toStrictEqual({
      kind: "diffed",
      skipped: [],
      hazards: [
        { kind: "data_loss", statement: 'alter table "public"."users" drop column "email";' },
      ],
    });
    expect(await rows("select * from public.users")).toStrictEqual([{ id: "kept" }]);
    expect(await recordedFilenames()).toStrictEqual(["000001-create-users.sql"]);
    expect(await recordedCurrent()).toStrictEqual([]);
  });

  it("keeps the data across a hand edit to current.sql and applies what the edit leaves", async () => {
    const fileSystem = await withCurrent(users, "('kept')");
    fileSystem.files.set(CURRENT, "create table public.users (id text, note text);\n");

    const result = await generateWith(fileSystem, users);

    expect(result.devDatabase).toStrictEqual({
      kind: "diffed",
      skipped: ["current.sql"],
      hazards: [],
    });
    expect(await rows("select id, note from public.users")).toStrictEqual([
      { id: "kept", note: null },
    ]);
  });

  it("rolls a failed step back, leaves the Dev database as it was, and names reset", async () => {
    const fileSystem = await withCurrent(withEmail, "('kept', 'a@b.c')");
    const before = await recordedCurrent();
    await db.driver.execute("create view public.emails as select email from public.users");

    const failure = generateWith(fileSystem, users);

    await expect(failure).rejects.toThrow(
      /^the Dev database didn't catch up, so it was left as it was: .+; run smonndb reset to rebuild it from the files$/su,
    );
    expect(await rows("select * from public.users")).toStrictEqual([
      { id: "kept", email: "a@b.c" },
    ]);
    expect(await recordedCurrent()).toStrictEqual(before);
  });

  it("rolls back when the Dev database still differs from the Shadow after the diff", async () => {
    const fileSystem = await withCurrent(users, "('kept')");
    // Adds a column behind every ALTER TABLE, so the diff can never leave the Dev database matching.
    await db.driver.execute(`
      create function public.sneak() returns event_trigger language plpgsql as $$
      begin
        if to_regclass('public.users') is not null and not exists (
          select from pg_attribute where attrelid = 'public.users'::regclass and attname = 'sneaky'
        ) then
          execute 'alter table public.users add column sneaky text';
        end if;
      end $$;
      create event trigger sneak on ddl_command_end when tag in ('ALTER TABLE')
        execute function public.sneak();`);
    const before = await recordedCurrent();

    const failure = generateWith(fileSystem, withEmail);

    await expect(failure).rejects.toThrow(
      /^the Dev database didn't catch up, so it was left as it was: the Dev database still differs from the files:\n.*sneaky.*; run smonndb reset/su,
    );
    expect(await rows("select * from public.users")).toStrictEqual([{ id: "kept" }]);
    expect(await recordedCurrent()).toStrictEqual(before);
  });
});
