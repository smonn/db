import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { defineDatabase, defineDomain, defineTable } from "../../runtime/definition/index.ts";
import { writeMigration } from "../../runtime/internal/index.ts";
import { generate } from "./generate.ts";
import { generateOptions } from "./generate-options.test-helper.ts";
import { filesIn, memoryFileSystem } from "./memory-file-system.test-helper.ts";

const db = useTestDatabase();

beforeEach(async () => {
  await db.driver.execute(
    "drop schema if exists smonn_db cascade; drop schema public cascade; create schema public;",
  );
});

type Definition = Parameters<typeof generate>[0]["definition"];

/** Generates against one Committed migration running `committed`. */
async function generateFrom(definition: Definition, committed: string) {
  const fileSystem = memoryFileSystem(
    filesIn("db/migrations", [await writeMigration("000001-start.sql", undefined, committed)]),
  );
  return generate(generateOptions(db, fileSystem, definition));
}

const D_AND_T = "create table public.t (n public.d);\n";

describe("generate with domains and the columns that use them", () => {
  it("rewrites when it adds a column of a NOT NULL domain with no checks to an existing table", async () => {
    const d = defineDomain((c) => c.integer(), { notNull: true });
    const definition = defineDatabase({
      public: { d, t: defineTable((c) => ({ a: c.integer(), n: c.domain(d) })) },
    });

    const result = await generateFrom(
      definition,
      "create domain public.d as integer not null;\ncreate table public.t (a integer);\n",
    );

    expect(result.sql).toBe(
      `-- hazard: rewrite\n-- hazard: access_exclusive_lock\nalter table "public"."t" add column "n" public.d;\n`,
    );
  });

  it("alters a domain before it adds a column of that domain", async () => {
    const d = defineDomain((c) => c.integer(), { checks: { positive: "value > 0" } });
    const definition = defineDatabase({
      public: { d, t: defineTable((c) => ({ a: c.integer(), n: c.domain(d) })) },
    });

    const result = await generateFrom(
      definition,
      "create domain public.d as integer;\ncreate table public.t (a integer);\n",
    );

    expect(result.sql).toBe(`-- hazard: share_lock
alter domain "public"."d" add constraint "positive" check ((VALUE > 0));

-- hazard: rewrite
-- hazard: access_exclusive_lock
alter table "public"."t" add column "n" public.d;
`);
  });

  it("drops a domain after the column that used it drops", async () => {
    const result = await generateFrom(
      defineDatabase({ public: { t: defineTable((c) => ({ a: c.integer() })) } }),
      "create domain public.d as integer;\ncreate table public.t (a integer, n public.d);\n",
    );

    expect(result.sql).toBe(
      `-- hazard: data_loss\nalter table "public"."t" drop column "n";\n\ndrop domain "public"."d";\n`,
    );
  });

  it("drops a domain after the column that used it retypes off it", async () => {
    const result = await generateFrom(
      defineDatabase({ public: { t: defineTable((c) => ({ n: c.integer() })) } }),
      `create domain public.d as integer;\n${D_AND_T}`,
    );

    expect(result.sql).toBe(
      `alter table "public"."t" alter column "n" type integer;\n\ndrop domain "public"."d";\n`,
    );
  });

  it("explains the Shadow error when an array column uses a domain that gains NOT NULL", async () => {
    const d = defineDomain((c) => c.integer(), { notNull: true });
    const definition = defineDatabase({
      public: { d, t: defineTable((c) => ({ n: c.domain(d).array() })) },
    });

    await expect(
      generateFrom(
        definition,
        "create domain public.d as integer;\ncreate table public.t (n public.d[]);\n",
      ),
    ).rejects.toThrow(
      `cannot alter type "d" because column "t.n" uses it\nGenerate adds a domain check or sets a domain NOT NULL with ALTER DOMAIN, which Postgres refuses while a column holds an array of the domain. Hand edit the Current migration to retype that column off the domain before the ALTER DOMAIN and back after it.`,
    );
  });
});
