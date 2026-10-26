import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { defineDatabase, defineEnum, defineTable } from "../../runtime/definition/index.ts";
import { writeMigration } from "../../runtime/internal/index.ts";
import { generate } from "./generate.ts";
import { filesIn, memoryFileSystem } from "./memory-file-system.test-helper.ts";
import { explainShadowError } from "./shadow-errors.ts";

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

/** A Committed migration that creates `mood` with `labels` and a table with a column of it. */
async function committedMood(labels: string): Promise<ReturnType<typeof memoryFileSystem>> {
  return memoryFileSystem(
    filesIn("db/migrations", [
      await writeMigration(
        "000001-create-mood.sql",
        undefined,
        `create type public.mood as enum (${labels});\ncreate table public.users (mood public.mood);\n`,
      ),
    ]),
  );
}

describe("generate with enums", () => {
  it("creates an enum and the column that uses it in one verified migration", async () => {
    const mood = defineEnum(["sad", "ok"]);

    const result = await generateFrom(
      defineDatabase({
        public: { mood, users: defineTable((c) => ({ mood: c.enum(mood).default("'ok'") })) },
      }),
    );

    expect(result.sql).toBe(`create type "public"."mood" as enum ('sad', 'ok');

create table "public"."users" (
  "mood" public.mood default ('ok'::public.mood)
);
`);
    expect(result.hazards).toStrictEqual([]);
  });

  it("uses a label in the migration that creates its type", async () => {
    const mood = defineEnum(["a"]);

    await expect(
      generateFrom(
        defineDatabase({
          public: {
            mood,
            users: defineTable((c) => ({ mood: c.enum(mood).notNull().default("'a'") })),
          },
        }),
      ),
    ).resolves.toMatchObject({ hazards: [] });
  });

  it("drops an enum that the Definition no longer has, after its table", async () => {
    const result = await generateFrom(defineDatabase({ public: {} }), await committedMood("'a'"));

    expect(result.sql).toBe(
      `-- hazard: data_loss\ndrop table "public"."users";\n\ndrop type "public"."mood";\n`,
    );
    expect(result.hazards).toStrictEqual([
      { kind: "data_loss", statement: `drop table "public"."users";` },
    ]);
  });

  it("adds a label in the middle with ADD VALUE and no Hazard", async () => {
    const mood = defineEnum(["a", "b", "c"]);

    const result = await generateFrom(
      defineDatabase({ public: { mood, users: defineTable((c) => ({ mood: c.enum(mood) })) } }),
      await committedMood("'a', 'c'"),
    );

    expect(result).toMatchObject({
      sql: `alter type "public"."mood" add value 'b' after 'a';\n`,
      hazards: [],
    });
    const { rows } = await db.driver.query(
      "select enumlabel from pg_enum where enumtypid = 'public.mood'::regtype order by enumsortorder",
    );
    expect(rows.map((row) => row["enumlabel"])).toStrictEqual(["a", "b", "c"]);
  });

  it("rethrows a new label's use in the same migration (55P04) with the fix", async () => {
    const mood = defineEnum(["a", "b"]);
    const definition = defineDatabase({
      public: {
        mood,
        users: defineTable((c) => ({ mood: c.enum(mood).default("'b'") })),
      },
    });

    await expect(generateFrom(definition, await committedMood("'a'"))).rejects.toThrow(
      /unsafe use of new value "b" of enum type mood\nGenerate adds the label.*commit the migration that adds the label, then use it in the next migration\./u,
    );
  });
});

/** The message of the error `explainShadowError` returns, or an empty string for anything else. */
function explained(error: unknown, options?: { readonly handEdited: boolean }): string {
  const result = explainShadowError(error, options);
  return result instanceof Error ? result.message : "";
}

describe("explainShadowError for 55P04", () => {
  const unsafe = Object.assign(new Error('unsafe use of new value "b" of enum type mood'), {
    code: "55P04",
  });

  it("tells a generated migration's author to commit the label first", () => {
    expect(explained(unsafe)).toMatch(
      /^unsafe use of new value "b" of enum type mood\nGenerate adds the label.*commit the migration that adds the label, then use it in the next migration\.$/u,
    );
  });

  it("keeps the Postgres error as the cause", () => {
    expect(explainShadowError(unsafe)).toHaveProperty("cause", unsafe);
  });

  it("words the fix for a hand edit", () => {
    expect(explained(unsafe, { handEdited: true })).toMatch(
      /Commit the label, then use it in the next migration\.$/u,
    );
  });
});
