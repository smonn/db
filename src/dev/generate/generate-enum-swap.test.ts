import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { defineDatabase, defineEnum, defineTable } from "../../runtime/definition/index.ts";
import { writeMigration } from "../../runtime/internal/index.ts";
import { generate } from "./generate.ts";
import { filesIn, memoryFileSystem } from "./memory-file-system.test-helper.ts";

const db = useTestDatabase();

beforeEach(async () => {
  await db.driver.execute(
    "drop schema if exists smonn_db cascade; drop schema public cascade; create schema public;",
  );
});

/** A Definition with `mood` holding `labels` and a table with a defaulted column of it. */
function withMood(...labels: string[]) {
  const mood = defineEnum(labels);
  return defineDatabase({
    public: { mood, users: defineTable((c) => ({ mood: c.enum(mood).default("'a'") })) },
  });
}

/** One Committed migration running `sql`. */
async function committed(sql: string): Promise<ReturnType<typeof memoryFileSystem>> {
  return memoryFileSystem(
    filesIn("db/migrations", [await writeMigration("000001-start.sql", undefined, sql)]),
  );
}

const generateFrom = async (definition: ReturnType<typeof withMood>, sql: string) =>
  generate({
    driver: db.driver,
    connect: db.connect,
    fileSystem: await committed(sql),
    definition,
    migrations: "db/migrations",
  });

const START = `create type public.mood as enum ('a', 'b', 'c');
create table public.users (mood public.mood default 'a');
insert into public.users values ('c'), ('a');
`;

describe("generate with an enum type swap", () => {
  it("removes a label in a migration the Shadow verifies, keeping the rows", async () => {
    const result = await generateFrom(withMood("a", "c"), START);

    expect(result.sql).toContain(
      `alter table "public"."users" alter column "mood" type public.mood using "mood"::text::public.mood;`,
    );
    expect(result.hazards.map(({ kind }) => kind)).toStrictEqual([
      "data_loss",
      "rewrite",
      "access_exclusive_lock",
    ]);
    const { rows } = await db.driver.query("select mood::text as mood from public.users");
    expect(rows.map((row) => row["mood"])).toStrictEqual(["c", "a"]);
  });

  it("reorders labels in a migration the Shadow verifies", async () => {
    const result = await generateFrom(withMood("c", "b", "a"), START);

    expect(result.hazards.map(({ kind }) => kind)).toStrictEqual([
      "rewrite",
      "access_exclusive_lock",
    ]);
    const { rows } = await db.driver.query(
      "select enumlabel from pg_enum where enumtypid = 'public.mood'::regtype order by enumsortorder",
    );
    expect(rows.map((row) => row["enumlabel"])).toStrictEqual(["c", "b", "a"]);
  });

  it("refuses the swap, naming each domain that depends on the enum", async () => {
    const sql = `${START}create domain public.calm as public.mood;
create domain public.moods as public.mood[];
`;

    const refused = generateFrom(withMood("c", "b", "a"), sql);

    await expect(refused).rejects.toThrow(
      /^Generate can't remove or reorder a label of the enum "public"\."mood" while a domain depends on it: "public"\."calm", "public"\."moods"\. /u,
    );
    await expect(refused).rejects.toThrow(
      / Generate wrote no migration: write this one by hand, dropping each domain before the swap and creating it again after, or drop the domains in an earlier migration\.$/u,
    );
  });

  it("adds a label beside a domain over the enum", async () => {
    const sql = `${START}create domain public.calm as public.mood;\n`;

    const result = await generateFrom(withMood("a", "b", "c", "d"), sql);

    expect(result.sql).toBe(`alter type "public"."mood" add value 'd' after 'c';\n`);
  });
});
