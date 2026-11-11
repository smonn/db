import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { defineDatabase, defineTable } from "../../runtime/definition/index.ts";
import { commit } from "./commit.ts";
import { generate, type GenerateResult } from "./generate.ts";
import { memoryFileSystem, type MemoryFileSystem } from "./memory-file-system.test-helper.ts";

const db = useTestDatabase();

const MIGRATIONS = "db/migrations";

type Definition = Parameters<typeof generate>[0]["definition"];

const empty = defineDatabase({});
const one = defineDatabase({ public: { users: defineTable((c) => ({ a: c.text() })) } });
const two = defineDatabase({
  public: { users: defineTable((c) => ({ a: c.text(), b: c.text() })) },
});

beforeEach(async () => {
  await db.driver.execute(
    "drop schema if exists smonn_db cascade; drop schema public cascade; create schema public;",
  );
});

function generateInto(
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

async function statuses(): Promise<unknown[]> {
  return (await db.driver.query("select filename, status from smonn_db.migrations order by 1"))
    .rows;
}

async function marked(): Promise<boolean> {
  const { rows } = await db.driver.query("select to_regclass('smonn_db.current') as found");
  return rows[0]?.["found"] !== null;
}

describe("whether generate resets the Dev database", () => {
  it("marks a fresh Database, though there is nothing to generate", async () => {
    const result = await generateInto(memoryFileSystem(), empty);

    expect(result.devDatabase.kind).toBe("reset");
    expect(await marked()).toBe(true);
  });

  it("leaves a marked Database that is up to date alone, though there is nothing to generate", async () => {
    const fileSystem = memoryFileSystem();
    await generateInto(fileSystem, empty);
    await db.driver.execute("create table public.keep (id int)");

    const result = await generateInto(fileSystem, empty);

    expect(result.devDatabase.kind).toBe("none");
    expect(
      (await db.driver.query("select to_regclass('public.keep') as found")).rows,
    ).toStrictEqual([{ found: "keep" }]);
  });

  it("leaves a Database up to date with two Committed migrations alone", async () => {
    const fileSystem = memoryFileSystem();
    await generateInto(fileSystem, one);
    await commitAs(fileSystem, "one");
    await generateInto(fileSystem, two);
    await commitAs(fileSystem, "two");
    await generateInto(fileSystem, two);

    const result = await generateInto(fileSystem, two);

    expect(result.devDatabase.kind).toBe("none");
  });

  it("replays the Committed files after the last recorded one, rather than resetting", async () => {
    const fileSystem = memoryFileSystem();
    await generateInto(fileSystem, one);
    await commitAs(fileSystem, "one");
    await generateInto(fileSystem, two);
    await commitAs(fileSystem, "two");
    await db.driver.execute(
      "delete from smonn_db.migrations where sequence = 2; alter table public.users drop column b",
    );

    const result = await generateInto(fileSystem, two);

    expect(result.devDatabase).toStrictEqual({
      kind: "replayed",
      files: ["000002-two.sql"],
      hazards: [],
    });
  });

  it("diffs a Database whose recorded hashes differ from the Committed files', keeping its rows", async () => {
    const fileSystem = memoryFileSystem();
    await generateInto(fileSystem, one);
    await commitAs(fileSystem, "one");
    await db.driver.execute(
      "update smonn_db.migrations set hash = 'sha256:other'; insert into public.users values ('kept')",
    );

    const result = await generateInto(fileSystem, two);

    expect(result.devDatabase).toStrictEqual({
      kind: "diffed",
      skipped: ["000001-one.sql", "current.sql"],
      hazards: [],
    });
    expect((await db.driver.query("select * from public.users")).rows).toStrictEqual([
      { a: "kept", b: null },
    ]);
    expect(await statuses()).toStrictEqual([{ filename: "000001-one.sql", status: "applied" }]);
    expect((await generateInto(fileSystem, two)).devDatabase.kind).toBe("none");
  });

  it("diffs a Database whose last recorded migration never finished, and records it applied", async () => {
    const fileSystem = memoryFileSystem();
    await generateInto(fileSystem, one);
    await commitAs(fileSystem, "one");
    await db.driver.execute("update smonn_db.migrations set status = 'failed'");

    const result = await generateInto(fileSystem, one);

    expect(result.devDatabase).toStrictEqual({
      kind: "diffed",
      skipped: ["000001-one.sql"],
      hazards: [],
    });
    expect(await statuses()).toStrictEqual([{ filename: "000001-one.sql", status: "applied" }]);
  });

  it("recreates a migrations table dropped by hand, silently when nothing else changes", async () => {
    const fileSystem = memoryFileSystem();
    await generateInto(fileSystem, one);
    await commitAs(fileSystem, "one");
    await db.driver.execute("drop table smonn_db.migrations");

    const result = await generateInto(fileSystem, one);

    expect(result.devDatabase).toStrictEqual({
      kind: "diffed",
      skipped: ["000001-one.sql"],
      hazards: [],
    });
    expect(await statuses()).toStrictEqual([{ filename: "000001-one.sql", status: "applied" }]);
  });

  it("reports no change when the diff only rewrote the markers", async () => {
    const fileSystem = memoryFileSystem();
    await generateInto(fileSystem, empty);
    await db.driver.execute("drop table smonn_db.migrations");

    const result = await generateInto(fileSystem, empty);

    expect(result.devDatabase).toStrictEqual({ kind: "none" });
    expect(await statuses()).toStrictEqual([]);
  });
});
