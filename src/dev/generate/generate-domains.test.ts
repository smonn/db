import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import {
  defineDatabase,
  defineDomain,
  defineEnum,
  defineTable,
  type DomainOptions,
} from "../../runtime/definition/index.ts";
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

/** Generates against one Committed migration running `committed`, or none. */
async function generateFrom(definition: Definition, committed?: string) {
  const fileSystem =
    committed === undefined
      ? memoryFileSystem()
      : memoryFileSystem(
          filesIn("db/migrations", [
            await writeMigration("000001-start.sql", undefined, committed),
          ]),
        );
  return generate(generateOptions(db, fileSystem, definition));
}

/** `public.d`, an integer domain with `options`, and the table `t` with an `n` column of it. */
function withD(options: DomainOptions = {}): Definition {
  const d = defineDomain((c) => c.integer(), options);
  return defineDatabase({ public: { d, t: defineTable((c) => ({ n: c.domain(d) })) } });
}

const D_AND_T = "create table public.t (n public.d);\n";

const kinds = (result: { readonly hazards: readonly { readonly kind: string }[] }) =>
  result.hazards.map(({ kind }) => kind);

describe("generate with domains", () => {
  it("creates a domain whole, checks included, before the table that uses it", async () => {
    const result = await generateFrom(
      withD({ notNull: true, default: "1", checks: { positive: "value > 0" } }),
    );

    expect(result.sql)
      .toBe(`create domain "public"."d" as integer not null default (1) constraint "positive" check ((VALUE > 0));

create table "public"."t" (
  "n" public.d
);
`);
    expect(result.hazards).toStrictEqual([]);
  });

  it("creates a domain over an enum after the enum", async () => {
    const mood = defineEnum(["a", "b"]);
    const calm = defineDomain((c) => c.enum(mood), { default: "'a'" });

    const result = await generateFrom(defineDatabase({ public: { calm, mood } }));

    expect(result.sql).toBe(`create type "public"."mood" as enum ('a', 'b');

create domain "public"."calm" as public.mood default ('a'::public.mood);
`);
  });

  it("creates a domain after the enum labels it uses, so the Shadow names the uncommitted label", async () => {
    const mood = defineEnum(["a", "b"]);
    const calm = defineDomain((c) => c.enum(mood), { default: "'b'" });

    await expect(
      generateFrom(
        defineDatabase({ public: { calm, mood } }),
        "create type public.mood as enum ('a');\n",
      ),
    ).rejects.toThrow(/unsafe use of new value "b" of enum type mood\nGenerate adds the label/u);
  });

  it("drops a domain after the table that used it", async () => {
    const result = await generateFrom(
      defineDatabase({ public: {} }),
      `create domain public.d as integer;\n${D_AND_T}`,
    );

    expect(result.sql).toBe(
      `-- hazard: data_loss\ndrop table "public"."t";\n\ndrop domain "public"."d";\n`,
    );
  });

  it("drops a domain before the enum it is over", async () => {
    const result = await generateFrom(
      defineDatabase({ public: {} }),
      "create type public.mood as enum ('a');\ncreate domain public.calm as public.mood;\n",
    );

    expect(result.sql).toBe(`drop domain "public"."calm";\n\ndrop type "public"."mood";\n`);
  });

  it("sets and drops a default with no Hazard", async () => {
    const set = await generateFrom(
      withD({ default: "2" }),
      `create domain public.d as integer default 1;\n${D_AND_T}`,
    );
    expect(set.sql).toBe(`alter domain "public"."d" set default (2);\n`);
    expect(set.hazards).toStrictEqual([]);

    const dropped = await generateFrom(
      withD(),
      `create domain public.d as integer default 1;\n${D_AND_T}`,
    );
    expect(dropped.sql).toBe(`alter domain "public"."d" drop default;\n`);
  });

  it("sets NOT NULL with share_lock and drops it with none", async () => {
    const set = await generateFrom(
      withD({ notNull: true }),
      `create domain public.d as integer;\n${D_AND_T}`,
    );
    expect(set.sql).toBe(`-- hazard: share_lock\nalter domain "public"."d" set not null;\n`);

    const dropped = await generateFrom(
      withD(),
      `create domain public.d as integer not null;\n${D_AND_T}`,
    );
    expect(dropped.sql).toBe(`alter domain "public"."d" drop not null;\n`);
  });

  it("adds a check with share_lock, drops one with none, and replaces a changed one", async () => {
    const committed = `create domain public.d as integer constraint positive check (value > 0) constraint small check (value < 10);\n${D_AND_T}`;

    const result = await generateFrom(
      withD({ checks: { small: "value < 100", even: "value % 2 = 0" } }),
      committed,
    );

    expect(result.sql).toBe(`alter domain "public"."d" drop constraint "positive";

alter domain "public"."d" drop constraint "small";

-- hazard: share_lock
alter domain "public"."d" add constraint "even" check (((VALUE % 2) = 0));

-- hazard: share_lock
alter domain "public"."d" add constraint "small" check ((VALUE < 100));
`);
  });

  it("reads a NOT VALID check as the check the Definition declares", async () => {
    const committed = `create domain public.d as integer;
alter domain public.d add constraint positive check (value > 0) not valid;
${D_AND_T}`;

    const result = await generateFrom(withD({ checks: { positive: "value > 0" } }), committed);

    expect(result.sql).toBeUndefined();
  });

  it("rewrites when it adds a column of a constrained domain to an existing table", async () => {
    const d = defineDomain((c) => c.integer(), { checks: { positive: "value > 0" } });
    const definition = defineDatabase({
      public: { d, t: defineTable((c) => ({ a: c.integer(), n: c.domain(d) })) },
    });

    const result = await generateFrom(
      definition,
      "create domain public.d as integer constraint positive check (value > 0);\ncreate table public.t (a integer);\n",
    );

    expect(result.sql).toBe(
      `-- hazard: rewrite\n-- hazard: access_exclusive_lock\nalter table "public"."t" add column "n" public.d;\n`,
    );
  });

  it("rewrites when it adds a column of a domain with a volatile default and none of its own", async () => {
    const id = defineDomain((c) => c.uuid(), { default: "gen_random_uuid()" });
    const committed =
      "create domain public.id as uuid default gen_random_uuid();\ncreate table public.t (a integer);\n";

    const result = await generateFrom(
      defineDatabase({
        public: { id, t: defineTable((c) => ({ a: c.integer(), n: c.domain(id) })) },
      }),
      committed,
    );
    expect(result.sql).toBe(
      `-- hazard: rewrite\n-- hazard: access_exclusive_lock\nalter table "public"."t" add column "n" public.id;\n`,
    );

    const ownDefault = await generateFrom(
      defineDatabase({
        public: {
          id,
          t: defineTable((c) => ({
            a: c.integer(),
            n: c.domain(id).default("'00000000-0000-0000-0000-000000000000'"),
          })),
        },
      }),
      committed,
    );
    expect(ownDefault.hazards).toStrictEqual([]);
  });

  it("retypes a column onto a domain over its type, rewriting only for a constrained one", async () => {
    const committed = "create table public.t (n integer);\n";

    const plain = await generateFrom(withD(), `create domain public.d as integer;\n${committed}`);
    expect(plain.sql).toBe(`alter table "public"."t" alter column "n" type public.d;\n`);
    expect(plain.hazards).toStrictEqual([]);

    const checked = await generateFrom(
      withD({ checks: { positive: "value > 0" } }),
      `create domain public.d as integer constraint positive check (value > 0);\n${committed}`,
    );
    expect(kinds(checked)).toStrictEqual(["rewrite", "access_exclusive_lock"]);
  });

  it("explains the Shadow error when an array column uses a domain that gains a check", async () => {
    const d = defineDomain((c) => c.integer(), { checks: { positive: "value > 0" } });
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

describe("generate refuses domain changes it can't write", () => {
  it("refuses a changed base type, naming the domain", async () => {
    const d = defineDomain((c) => c.bigint());

    await expect(
      generateFrom(defineDatabase({ public: { d } }), "create domain public.d as integer;\n"),
    ).rejects.toThrow(
      `Generate can't change the base type of the domain "public"."d" from integer to bigint: Postgres has no ALTER DOMAIN for it. Generate wrote no migration: `,
    );
  });

  it("refuses an enum that becomes a domain, and a domain that becomes an enum, naming the type", async () => {
    const asDomain = defineDatabase({ public: { mood: defineDomain((c) => c.text()) } });
    const asEnum = defineDatabase({ public: { mood: defineEnum(["a"]) } });

    await expect(
      generateFrom(asDomain, "create type public.mood as enum ('a');\n"),
    ).rejects.toThrow(
      `Generate can't replace the enum "public"."mood" with a domain of the same name in one migration: it creates types before it drops them, so the two would clash. Generate wrote no migration: remove the enum from the Definition and commit that migration, then add the domain.`,
    );
    await expect(generateFrom(asEnum, "create domain public.mood as text;\n")).rejects.toThrow(
      `Generate can't replace the domain "public"."mood" with an enum of the same name in one migration`,
    );
  });
});
