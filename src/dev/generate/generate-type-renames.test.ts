import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import {
  defineDatabase,
  defineDomain,
  defineEnum,
  defineTable,
  type EnumOptions,
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

async function generateFrom(definition: Definition, committed: string) {
  const fileSystem = memoryFileSystem(
    filesIn("db/migrations", [await writeMigration("000001-start.sql", undefined, committed)]),
  );
  return generate(generateOptions(db, fileSystem, definition));
}

/** `public.mood` holding `labels`, and a table with a defaulted column of it. */
function withMood(labels: string[], options: EnumOptions = {}): Definition {
  const mood = defineEnum(labels, options);
  return defineDatabase({
    public: {
      mood,
      users: defineTable((c) => ({ mood: c.enum(mood).default(`'${labels[0] ?? ""}'`) })),
    },
  });
}

const OLD_MOOD = `create type public.old_mood as enum ('good', 'bad');
create table public.users (mood public.old_mood default 'good');
insert into public.users values ('bad'), ('good');
`;

const MOOD = OLD_MOOD.replaceAll("old_mood", "mood");

describe("an enum rename", () => {
  it("renames the type with the rename Hazard, keeping every row", async () => {
    const result = await generateFrom(
      withMood(["good", "bad"], { renamedFrom: "old_mood" }),
      OLD_MOOD,
    );

    const statement = `alter type "public"."old_mood" rename to "mood";`;
    expect(result.sql).toBe(`-- hazard: rename\n${statement}\n`);
    expect(result.hazards).toStrictEqual([{ kind: "rename", statement }]);
    expect(result.hints).toStrictEqual([]);
  });

  it("ignores a marker whose old name is gone", async () => {
    const result = await generateFrom(withMood(["good", "bad"], { renamedFrom: "old_mood" }), MOOD);

    expect(result.sql).toBeUndefined();
  });

  it("throws when the old and new names both exist", async () => {
    const both = `${MOOD}create type public.old_mood as enum ('good', 'bad');\n`;

    await expect(
      generateFrom(withMood(["good", "bad"], { renamedFrom: "old_mood" }), both),
    ).rejects.toThrow('enum "public"."mood" has renamedFrom "old_mood"');
  });
});

describe("a label rename", () => {
  it("renames the label in place with the rename Hazard, instead of swapping the type", async () => {
    const result = await generateFrom(
      withMood(["great", "bad"], { renamedLabels: { great: "good" } }),
      MOOD,
    );

    const statement = `alter type "public"."mood" rename value 'good' to 'great';`;
    expect(result.sql).toBe(`-- hazard: rename\n${statement}\n`);
    expect(result.hazards).toStrictEqual([{ kind: "rename", statement }]);
    expect(result.hints).toStrictEqual([]);
  });

  it("renames the enum first, then the label under the new name", async () => {
    const result = await generateFrom(
      withMood(["great", "bad"], {
        renamedFrom: "old_mood",
        renamedLabels: { great: "good" },
      }),
      OLD_MOOD,
    );

    expect(result.sql?.trimEnd().split("\n\n")).toStrictEqual([
      `-- hazard: rename\nalter type "public"."old_mood" rename to "mood";`,
      `-- hazard: rename\nalter type "public"."mood" rename value 'good' to 'great';`,
    ]);
  });

  it("renames a label beside an added one, without a swap", async () => {
    const result = await generateFrom(
      withMood(["great", "bad", "ok"], { renamedLabels: { great: "good" } }),
      MOOD,
    );

    expect(result.sql?.trimEnd().split("\n\n")).toStrictEqual([
      `-- hazard: rename\nalter type "public"."mood" rename value 'good' to 'great';`,
      `alter type "public"."mood" add value 'ok' after 'bad';`,
    ]);
  });

  it("renames a label of an enum a domain depends on, which a swap would refuse", async () => {
    const mood = defineEnum(["great", "bad"], { renamedLabels: { great: "good" } });
    const calm = defineDomain((c) => c.enum(mood));
    const definition = defineDatabase({ public: { mood, calm } });

    const result = await generateFrom(
      definition,
      "create type public.mood as enum ('good', 'bad');\ncreate domain public.calm as public.mood;\n",
    );

    expect(result.sql).toBe(
      `-- hazard: rename\nalter type "public"."mood" rename value 'good' to 'great';\n`,
    );
  });

  it("ignores an entry whose old label is gone", async () => {
    const result = await generateFrom(
      withMood(["great", "bad"], { renamedLabels: { great: "good" } }),
      "create type public.mood as enum ('great', 'bad');\ncreate table public.users (mood public.mood default 'great');\n",
    );

    expect(result.sql).toBeUndefined();
  });

  it("throws when the old and new labels both exist", async () => {
    const both = `create type public.mood as enum ('good', 'great', 'bad');
create table public.users (mood public.mood default 'good');\n`;

    await expect(
      generateFrom(withMood(["great", "bad"], { renamedLabels: { great: "good" } }), both),
    ).rejects.toThrow('enum "public"."mood" has renamedLabels "great" from "good"');
  });

  it("throws for a label the enum doesn't list", async () => {
    // @ts-expect-error -- "ghost" isn't one of the enum's labels.
    const mood = defineEnum(["good", "bad"], { renamedLabels: { ghost: "good" } });

    await expect(generateFrom(defineDatabase({ public: { mood } }), MOOD)).rejects.toThrow(
      `enum "public"."mood" has renamedLabels for "ghost", which it doesn't list`,
    );
  });
});

describe("an enum rename beside a removed label", () => {
  it("swaps the type under its new name, retyping a scalar and an array column", async () => {
    const mood = defineEnum(["good"], { renamedFrom: "old_mood" });
    const definition = defineDatabase({
      public: {
        mood,
        users: defineTable((c) => ({ one: c.enum(mood), many: c.enum(mood).array() })),
      },
    });
    const committed = `create type public.old_mood as enum ('good', 'bad');
create table public.users (one public.old_mood, many public.old_mood[]);
insert into public.users values ('good', '{good}');
`;

    const result = await generateFrom(definition, committed);

    const hazards = "-- hazard: data_loss\n-- hazard: rewrite\n-- hazard: access_exclusive_lock";
    const retype = (column: string, cast: string) =>
      `${hazards}\nalter table "public"."users" alter column "${column}" type ${cast} using "${column}"::text::${cast};`;
    expect(result.sql?.trimEnd().split("\n\n")).toStrictEqual([
      `-- hazard: rename\nalter type "public"."old_mood" rename to "mood";`,
      `alter type "public"."mood" rename to "mood_old";`,
      `create type "public"."mood" as enum ('good');`,
      retype("one", "public.mood"),
      retype("many", "public.mood[]"),
      `drop type "public"."mood_old";`,
    ]);
    const { rows } = await db.driver.query("select one::text as one from public.users");
    expect(rows.map((row) => row["one"])).toStrictEqual(["good"]);
  });
});

describe("the label rename hint", () => {
  const EMPTY = MOOD.split("insert")[0] ?? "";

  it("names the entry to add when an enum removes one label and adds one at the same position", async () => {
    const result = await generateFrom(withMood(["great", "bad"]), EMPTY);

    expect(result.hints).toStrictEqual([
      `enum "public"."mood" may rename the label "good" to "great": add renamedLabels: { "great": "good" } to its options`,
    ]);
    expect(result.hazards.map(({ kind }) => kind)).toContain("data_loss");
  });

  it("stays quiet when the added label sits elsewhere", async () => {
    const result = await generateFrom(withMood(["bad", "great"]), EMPTY);

    expect(result.hints).toStrictEqual([]);
  });
});

const RENAMED_D = ((): Definition => {
  const d = defineDomain((c) => c.integer(), { renamedFrom: "old_d" });
  return defineDatabase({ public: { d, t: defineTable((c) => ({ n: c.domain(d) })) } });
})();

describe("a domain rename", () => {
  const OLD_D = "create domain public.old_d as integer;\ncreate table public.t (n public.old_d);\n";

  it("renames the domain with the rename Hazard", async () => {
    const result = await generateFrom(RENAMED_D, OLD_D);

    const statement = `alter domain "public"."old_d" rename to "d";`;
    expect(result.sql).toBe(`-- hazard: rename\n${statement}\n`);
    expect(result.hazards).toStrictEqual([{ kind: "rename", statement }]);
  });

  it("ignores a marker whose old name is gone", async () => {
    const result = await generateFrom(RENAMED_D, OLD_D.replaceAll("old_d", "d"));

    expect(result.sql).toBeUndefined();
  });

  it("throws when the old and new names both exist", async () => {
    const both = `${OLD_D.replaceAll("old_d", "d")}create domain public.old_d as integer;\n`;

    await expect(generateFrom(RENAMED_D, both)).rejects.toThrow(
      'domain "public"."d" has renamedFrom "old_d"',
    );
  });

  it("renames a check by its expression, with no Hazard", async () => {
    const d = defineDomain((c) => c.integer(), { checks: { positive: "value > 0" } });
    const definition = defineDatabase({
      public: { d, t: defineTable((c) => ({ n: c.domain(d) })) },
    });
    const committed =
      "create domain public.d as integer constraint above_zero check (value > 0);\ncreate table public.t (n public.d);\n";

    const result = await generateFrom(definition, committed);

    expect(result.sql).toBe(
      `alter domain "public"."d" rename constraint "above_zero" to "positive";\n`,
    );
    expect(result.hazards).toStrictEqual([]);
  });

  it("renames the domain and its check in one migration", async () => {
    const d = defineDomain((c) => c.integer(), {
      renamedFrom: "old_d",
      checks: { positive: "value > 0" },
    });
    const definition = defineDatabase({
      public: { d, t: defineTable((c) => ({ n: c.domain(d) })) },
    });
    const committed =
      "create domain public.old_d as integer constraint above_zero check (value > 0);\ncreate table public.t (n public.old_d);\n";

    const result = await generateFrom(definition, committed);

    expect(result.sql?.trimEnd().split("\n\n")).toStrictEqual([
      `-- hazard: rename\nalter domain "public"."old_d" rename to "d";`,
      `alter domain "public"."d" rename constraint "above_zero" to "positive";`,
    ]);
  });
});
