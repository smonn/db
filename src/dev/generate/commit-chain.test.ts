import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { defineDatabase, defineTable } from "../../runtime/definition/index.ts";
import { parseMigration } from "../../runtime/internal/index.ts";
import { commit } from "./commit.ts";
import { generate } from "./generate.ts";
import { memoryFileSystem, type MemoryFileSystem } from "./memory-file-system.test-helper.ts";

const db = useTestDatabase();

const MIGRATIONS = "db/migrations";

type Definition = Parameters<typeof generate>[0]["definition"];

const one = defineDatabase({ public: { users: defineTable((c) => ({ a: c.text() })) } });
const two = defineDatabase({
  public: { users: defineTable((c) => ({ a: c.text(), b: c.text() })) },
});
const three = defineDatabase({
  public: { users: defineTable((c) => ({ a: c.text(), b: c.text(), c: c.text() })) },
});

beforeEach(async () => {
  await db.driver.execute(
    "drop schema if exists smonn_db cascade; drop schema public cascade; create schema public;",
  );
});

async function generateInto(fileSystem: MemoryFileSystem, definition: Definition): Promise<void> {
  await generate({
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

describe("commit onto a chain", () => {
  it("chains the third file onto the second, not the first", async () => {
    const fileSystem = memoryFileSystem();
    for (const [slug, definition] of [
      ["one", one],
      ["two", two],
      ["three", three],
    ] as const) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- each file builds on the one before it.
      await generateInto(fileSystem, definition);
      // oxlint-disable-next-line eslint/no-await-in-loop -- each file builds on the one before it.
      await commitAs(fileSystem, slug);
    }

    const parsed = ["000002-two.sql", "000003-three.sql"].map((name) =>
      parseMigration({ filename: name, content: fileSystem.files.get(`${MIGRATIONS}/${name}`)! }),
    );
    expect(parsed[1]?.previous).toBe(parsed[0]?.hash);
  });
});

describe("the slug of a commit", () => {
  it.each(["users", "add-email", "v2-users", "a1"])("accepts %s", async (slug) => {
    const fileSystem = memoryFileSystem();
    await generateInto(fileSystem, one);

    await commitAs(fileSystem, slug);

    expect(fileSystem.files.has(`${MIGRATIONS}/000001-${slug}.sql`)).toBe(true);
  });

  it.each(["Users", "add--email", "add-", "-add", "add email", "add-email!", "add_email", ""])(
    "refuses %j before it touches anything",
    async (slug) => {
      const fileSystem = memoryFileSystem();
      await generateInto(fileSystem, one);
      const before = new Map(fileSystem.files);

      await expect(commitAs(fileSystem, slug)).rejects.toThrow("must be kebab-case");
      expect(fileSystem.files).toStrictEqual(before);
    },
  );
});

describe("a commit that is refused before it writes", () => {
  it("removes nothing", async () => {
    const fileSystem = memoryFileSystem();
    await generateInto(fileSystem, one);
    await db.driver.execute("drop schema smonn_db cascade");
    const removed: string[] = [];
    const spy: MemoryFileSystem = {
      ...fileSystem,
      remove: (path) => {
        removed.push(path);
        return fileSystem.remove(path);
      },
    };

    await expect(commitAs(spy, "one")).rejects.toThrow("run generate first");
    expect(removed).toStrictEqual([]);
  });
});
