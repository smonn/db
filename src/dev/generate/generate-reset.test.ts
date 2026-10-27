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

async function marked(): Promise<boolean> {
  const { rows } = await db.driver.query("select to_regclass('smonn_db.current') as found");
  return rows[0]?.["found"] !== null;
}

describe("whether generate resets the Dev database", () => {
  it("marks a fresh Database, though there is nothing to generate", async () => {
    const result = await generateInto(memoryFileSystem(), empty);

    expect(result.reset).toBe(true);
    expect(await marked()).toBe(true);
  });

  it("leaves a marked Database that is up to date alone, though there is nothing to generate", async () => {
    const fileSystem = memoryFileSystem();
    await generateInto(fileSystem, empty);
    await db.driver.execute("create table public.keep (id int)");

    const result = await generateInto(fileSystem, empty);

    expect(result.reset).toBe(false);
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

    expect(result.reset).toBe(false);
  });

  it("resets a Database whose last recorded migration isn't the Committed tip", async () => {
    const fileSystem = memoryFileSystem();
    await generateInto(fileSystem, one);
    await commitAs(fileSystem, "one");
    await generateInto(fileSystem, two);
    await commitAs(fileSystem, "two");
    await db.driver.execute("delete from smonn_db.migrations where sequence = 2");

    const result = await generateInto(fileSystem, two);

    expect(result.reset).toBe(true);
  });
});
