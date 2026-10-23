import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import type { Connection } from "../../runtime/ports/index.ts";
import { defineDatabase, defineTable } from "../../runtime/definition/index.ts";
import { parseMigration, readCommitted, writeMigration } from "../../runtime/internal/index.ts";
import { commit } from "./commit.ts";
import { generate } from "./generate.ts";
import { memoryFileSystem, type MemoryFileSystem } from "./memory-file-system.test-helper.ts";
import { reset } from "./reset.ts";

const db = useTestDatabase();

const MIGRATIONS = "db/migrations";
const CURRENT = `${MIGRATIONS}/current.sql`;

const users = defineDatabase({ public: { users: defineTable((c) => ({ id: c.text() })) } });
const withEmail = defineDatabase({
  public: { users: defineTable((c) => ({ id: c.text(), email: c.text() })) },
});

beforeEach(async () => {
  await db.driver.execute(
    "drop schema if exists smonn_db cascade; drop schema public cascade; create schema public;",
  );
});

async function generateInto(fileSystem: MemoryFileSystem, definition = users): Promise<boolean> {
  const result = await generate({
    driver: db.driver,
    connect: db.connect,
    fileSystem,
    definition,
    migrations: MIGRATIONS,
  });
  return result.reset;
}

async function hasJunk(): Promise<boolean> {
  const { rows } = await db.driver.query("select to_regclass('public.junk') is not null as found");
  return rows[0]?.["found"] === true;
}

describe("Dev database catch-up", () => {
  it("keeps the Dev database when current.sql and the Committed tip already match it", async () => {
    const fileSystem = memoryFileSystem();
    expect(await generateInto(fileSystem)).toBe(true);
    await db.driver.execute("create table public.junk (id int)");

    expect(await generateInto(fileSystem)).toBe(false);

    expect(await hasJunk()).toBe(true);
  });

  it("keeps the Dev database when a hand-edited current.sql already matches it", async () => {
    const fileSystem = memoryFileSystem({ [CURRENT]: "select 1;\n" });
    await generateInto(fileSystem);
    await db.driver.execute("create table public.junk (id int)");

    await generateInto(fileSystem);

    expect(await hasJunk()).toBe(true);
  });

  it("resets when the Current migration's hash differs from smonn_db.current", async () => {
    const fileSystem = memoryFileSystem();
    await generateInto(fileSystem);
    await db.driver.execute("create table public.junk (id int)");

    expect(await generateInto(fileSystem, withEmail)).toBe(true);

    expect(await hasJunk()).toBe(false);
  });

  it("resets when a pulled Committed migration moves the tip but leaves the Current migration as it was", async () => {
    const fileSystem = memoryFileSystem();
    await generateInto(fileSystem);
    await commit({ driver: db.driver, fileSystem, migrations: MIGRATIONS, slug: "create-users" });
    await generateInto(fileSystem, withEmail);
    await db.driver.execute("create table public.junk (id int)");
    const [tip] = (await readCommitted(fileSystem, MIGRATIONS)).map((file) => parseMigration(file));
    const pulled = await writeMigration("000002-noop.sql", tip?.hash, "select 1;\n");
    fileSystem.files.set(`${MIGRATIONS}/000002-noop.sql`, pulled.content);
    const before = fileSystem.files.get(CURRENT);

    await generateInto(fileSystem, withEmail);

    expect(fileSystem.files.get(CURRENT)).toBe(before);
    expect(await hasJunk()).toBe(false);
    const { rows } = await db.driver.query("select filename from smonn_db.migrations order by 1");
    expect(rows.map((row) => row["filename"])).toStrictEqual([
      "000001-create-users.sql",
      "000002-noop.sql",
    ]);
  });
});

describe("Dev lock", () => {
  // "SMONNDBDEV" on a phone keypad.
  const KEY = 7666632338;

  it.each(["generate", "commit", "reset"] as const)(
    "makes %s exit at once, naming the lock, while another run holds it",
    async (command) => {
      const fileSystem = memoryFileSystem();
      const run = {
        generate: () => generateInto(fileSystem),
        commit: () =>
          commit({ driver: db.driver, fileSystem, migrations: MIGRATIONS, slug: "create-users" }),
        reset: () => reset({ driver: db.driver, fileSystem, migrations: MIGRATIONS }),
      }[command];

      await db.driver.session(async (holder) => {
        await holder.query(`select pg_advisory_lock(${KEY})`);
        await expect(run()).rejects.toThrow(
          `can't ${command}: another generate, commit, or reset holds advisory lock ${KEY}`,
        );
      });
      expect(fileSystem.files.size).toBe(0);
    },
  );

  // The lock is re-entrant on one backend, so only another connection can tell it was released.
  async function lockedElsewhere(): Promise<boolean> {
    const other = await db.connect(db.name);
    try {
      const { rows } = await other.driver.query(
        `select pg_try_advisory_lock(${KEY}) as acquired, pg_advisory_unlock(${KEY})`,
      );
      return rows[0]?.["acquired"] !== true;
    } finally {
      await other.close();
    }
  }

  it("releases the lock when a run finishes", async () => {
    await generateInto(memoryFileSystem());

    expect(await lockedElsewhere()).toBe(false);
  });

  it("releases the lock when a run fails", async () => {
    await db.driver.execute("create table public.junk (id int)");
    await expect(
      reset({ driver: db.driver, fileSystem: memoryFileSystem(), migrations: MIGRATIONS }),
    ).rejects.toThrow("reset needs --erase");

    expect(await lockedElsewhere()).toBe(false);
  });
});

describe("dev commands on a one-connection pool", () => {
  let pool: Connection;

  beforeAll(async () => {
    pool = await db.connectSingle(db.name);
  });
  afterAll(() => pool.close());

  it("runs generate, commit, and reset without waiting on a second connection", async () => {
    const fileSystem = memoryFileSystem();
    const options = { driver: pool.driver, fileSystem, migrations: MIGRATIONS };

    await generate({ ...options, connect: db.connect, definition: users });
    await commit({ ...options, slug: "create-users" });
    await reset(options);

    const { rows } = await pool.driver.query("select filename from smonn_db.migrations");
    expect(rows).toStrictEqual([{ filename: "000001-create-users.sql" }]);
  });
});
