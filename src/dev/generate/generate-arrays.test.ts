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

const generateFrom = (
  definition: Parameters<typeof generate>[0]["definition"],
  fileSystem = memoryFileSystem(),
) =>
  generate({
    driver: db.driver,
    connect: db.connect,
    fileSystem,
    definition,
    migrations: "db/migrations",
  });

/** A Committed migration that runs `sql`. */
async function committed(sql: string): Promise<ReturnType<typeof memoryFileSystem>> {
  return memoryFileSystem(
    filesIn("db/migrations", [await writeMigration("000001-create.sql", undefined, sql)]),
  );
}

const REWRITE = ["rewrite", "access_exclusive_lock"];

describe("generate with array columns", () => {
  it("creates array columns, with a default for the whole column, in one verified migration", async () => {
    const mood = defineEnum(["sad", "ok"]);

    const result = await generateFrom(
      defineDatabase({
        public: {
          mood,
          t: defineTable((c) => ({
            tags: c.text().array().notNull().default("'{}'"),
            names: c.varchar(20).array(),
            moods: c.enum(mood).array(),
          })),
        },
      }),
    );

    expect(result.sql).toContain(`  "tags" text[] not null default ('{}'::text[]),`);
    expect(result.sql).toContain(`  "names" character varying(20)[],`);
    expect(result.sql).toContain(`  "moods" public.mood[]`);
    expect(result.hazards).toStrictEqual([]);
  });

  it("adds an array column to an existing table", async () => {
    const result = await generateFrom(
      defineDatabase({
        public: { t: defineTable((c) => ({ id: c.integer(), tags: c.text().array() })) },
      }),
      await committed("create table public.t (id integer);"),
    );

    expect(result.sql).toBe(`alter table "public"."t" add column "tags" text[];\n`);
    expect(result.hazards).toStrictEqual([]);
  });

  it("rewrites for varchar(20)[] to varchar(40)[]", async () => {
    const result = await generateFrom(
      defineDatabase({ public: { t: defineTable((c) => ({ v: c.varchar(40).array() })) } }),
      await committed("create table public.t (v varchar(20)[]);"),
    );

    const statement = `alter table "public"."t" alter column "v" type character varying(40)[];`;
    expect(result.sql).toBe(`-- hazard: rewrite\n-- hazard: access_exclusive_lock\n${statement}\n`);
    expect(result.hazards.map((hazard) => hazard.kind)).toStrictEqual(REWRITE);
  });

  it("sends scalar to array to a hand edit, since Postgres has no implicit cast", async () => {
    const array = defineDatabase({ public: { t: defineTable((c) => ({ v: c.text().array() })) } });

    await expect(
      generateFrom(array, await committed("create table public.t (v text);")),
    ).rejects.toThrow(
      /cannot be cast automatically to type text\[\][\s\S]*Hand edit the Current migration/u,
    );
  });

  it("carries every Hazard from array to scalar", async () => {
    const result = await generateFrom(
      defineDatabase({ public: { t: defineTable((c) => ({ v: c.text() })) } }),
      await committed("create table public.t (v text[]);"),
    );

    expect(new Set(result.hazards.map((hazard) => hazard.kind))).toStrictEqual(
      new Set([
        "data_loss",
        "rewrite",
        "access_exclusive_lock",
        "share_row_exclusive_lock",
        "rename",
      ]),
    );
  });

  it("accepts a hand edit that converts a scalar into an array", async () => {
    const fileSystem = await committed("create table public.t (v text);");
    fileSystem.files.set(
      "db/migrations/current.sql",
      'alter table "public"."t" alter column "v" type text[] using array["v"];\n',
    );

    const result = await generateFrom(
      defineDatabase({ public: { t: defineTable((c) => ({ v: c.text().array() })) } }),
      fileSystem,
    );

    expect(result.leftover).toBeUndefined();
  });
});
