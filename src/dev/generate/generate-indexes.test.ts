import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import {
  defineDatabase,
  defineTable,
  type ColumnFactories,
  type ColumnRefs,
  type IndexMethod,
} from "../../runtime/definition/index.ts";
import { writeMigration } from "../../runtime/internal/index.ts";
import { generate } from "./generate.ts";
import { filesIn, memoryFileSystem } from "./memory-file-system.test-helper.ts";

const db = useTestDatabase();

const CURRENT = "db/migrations/current.sql";

beforeEach(async () => {
  await db.driver.execute(
    "drop schema if exists smonn_db cascade; drop schema public cascade; create schema public;",
  );
});

async function committed(sql: string) {
  return memoryFileSystem({
    ...filesIn("db/migrations", [await writeMigration("000001-create-tables.sql", undefined, sql)]),
  });
}

function run(fileSystem: ReturnType<typeof memoryFileSystem>, definition: Definition) {
  return generate({
    driver: db.driver,
    connect: db.connect,
    fileSystem,
    definition,
    migrations: "db/migrations",
  });
}

type Definition = Parameters<typeof generate>[0]["definition"];

const columns = (c: ColumnFactories) => ({
  a: c.integer(),
  b: c.text(),
  c: c.integer(),
  tags: c.text().array(),
});

type Refs = ColumnRefs<ReturnType<typeof columns>>;
type AnyRef = Refs[keyof Refs];
type Key =
  | AnyRef
  | { readonly key: AnyRef; readonly order?: "asc" | "desc"; readonly nulls?: "first" | "last" };
type Entry = {
  readonly columns: readonly [Key, ...Key[]];
  readonly include?: readonly AnyRef[];
  readonly method?: IndexMethod;
  readonly unique?: boolean;
  readonly nullsNotDistinct?: boolean;
  readonly name?: string;
};

/** A `slots` table whose second callback declares the indexes `entries` returns. */
function slots(entries: (t: Refs) => readonly Entry[] = () => []) {
  return defineDatabase({
    public: { slots: defineTable(columns, (t) => ({ indexes: entries(t) })) },
  });
}

const TABLE = "create table public.slots (a integer, b text, c integer, tags text[]);\n";
const NOTHING = { path: CURRENT, sql: undefined, reset: true, hazards: [], hints: [] };

describe("generating an index", () => {
  it("creates a table with every option and verifies the Shadow database matches", async () => {
    const result = await run(
      memoryFileSystem(),
      slots((t) => [
        { columns: [t.b, t.a] },
        {
          columns: [
            { key: t.a, order: "desc" },
            { key: t.c, nulls: "first" },
          ],
          name: "ordered",
        },
        { columns: [t.a], include: [t.b, t.c], unique: true, name: "covering" },
        { columns: [t.a, t.c], unique: true, nullsNotDistinct: true, name: "nnd" },
        { columns: [t.c], method: "hash", name: "hashed" },
        { columns: [t.c], method: "brin", name: "ranged" },
        { columns: [t.tags], method: "gin", name: "tagged" },
      ]),
    );

    for (const statement of [
      `create index "slots_b_a_idx" on "public"."slots" ("b", "a");`,
      `create index "ordered" on "public"."slots" ("a" desc, "c" nulls first);`,
      `create unique index "covering" on "public"."slots" ("a") include ("b", "c");`,
      `create unique index "nnd" on "public"."slots" ("a", "c") nulls not distinct;`,
      `create index "hashed" on "public"."slots" using hash ("c");`,
      `create index "ranged" on "public"."slots" using brin ("c");`,
      `create index "tagged" on "public"."slots" using gin ("tags");`,
    ]) {
      expect(result.sql).toContain(statement);
    }
    expect(result.hazards).toStrictEqual([]);
  });

  it("creates a column's .index() with its method and name", async () => {
    const result = await run(
      memoryFileSystem(),
      defineDatabase({
        public: {
          slots: defineTable((c) => ({
            a: c.integer().index(),
            b: c.integer().index({ method: "hash" }).index({ name: "slots_b_second" }),
          })),
        },
      }),
    );

    expect(result.sql).toContain(`create index "slots_a_idx" on "public"."slots" ("a");`);
    expect(result.sql).toContain(
      `create index "slots_b_idx" on "public"."slots" using hash ("b");`,
    );
    expect(result.sql).toContain(`create index "slots_b_second" on "public"."slots" ("b");`);
  });

  it("finds no difference from a Committed migration that adds it with Postgres's name", async () => {
    const fileSystem = await committed(`${TABLE}create index on public.slots (b, a);
create unique index covering on public.slots (a) include (b, c) nulls not distinct;
create index ordered on public.slots using hash (c);
create index tagged on public.slots using gin (tags);
create index desc_first on public.slots (a desc, c nulls first, b desc nulls last);
`);

    const result = await run(
      fileSystem,
      slots((t) => [
        { columns: [t.b, t.a] },
        {
          columns: [t.a],
          include: [t.b, t.c],
          unique: true,
          nullsNotDistinct: true,
          name: "covering",
        },
        { columns: [t.c], method: "hash", name: "ordered" },
        { columns: [t.tags], method: "gin", name: "tagged" },
        {
          columns: [
            { key: t.a, order: "desc" },
            { key: t.c, nulls: "first" },
            { key: t.b, order: "desc", nulls: "last" },
          ],
          name: "desc_first",
        },
      ]),
    );

    expect(result).toStrictEqual(NOTHING);
  });

  it("adds one to an existing table with the share_lock Hazard, and verifies the Shadow database", async () => {
    const result = await run(
      await committed(TABLE),
      slots((t) => [{ columns: [t.a, t.b] }]),
    );

    const statement = `create index "slots_a_b_idx" on "public"."slots" ("a", "b");`;
    expect(result.sql).toBe(`-- hazard: share_lock\n${statement}\n`);
    expect(result.hazards).toStrictEqual([{ kind: "share_lock", statement }]);
    expect(result.sql).not.toContain("concurrently");
  });

  it("drops one that the Definition stops declaring, with no Hazard", async () => {
    const fileSystem = await committed(`${TABLE}create index on public.slots (a, b);\n`);

    const result = await run(fileSystem, slots());

    expect(result.sql).toBe(`drop index "public"."slots_a_b_idx";\n`);
    expect(result.hazards).toStrictEqual([]);
  });

  it("rebuilds one whose payload changed, and verifies the Shadow database", async () => {
    const fileSystem = await committed(`${TABLE}create index ix on public.slots (a, b);\n`);
    const rebuilt = async (entry: (t: Refs) => Entry) => {
      const result = await run(
        fileSystem,
        slots((t) => [{ ...entry(t), name: "ix" }]),
      );
      expect(result.sql).toContain(`drop index "public"."ix";`);
      return result.sql;
    };

    expect(await rebuilt((t) => ({ columns: [t.a, t.c] }))).toContain(`("a", "c");`);
    expect(await rebuilt((t) => ({ columns: [t.b, t.a] }))).toContain(`("b", "a");`);
    expect(await rebuilt((t) => ({ columns: [{ key: t.a, order: "desc" }, t.b] }))).toContain(
      `("a" desc, "b");`,
    );
    expect(await rebuilt((t) => ({ columns: [t.a, t.b], unique: true }))).toContain(
      "create unique index",
    );
    expect(await rebuilt((t) => ({ columns: [t.a, t.b], include: [t.c] }))).toContain(
      `include ("c")`,
    );
    expect(
      await rebuilt((t) => ({ columns: [t.a, t.b], unique: true, nullsNotDistinct: true })),
    ).toContain("nulls not distinct");
  });

  it("rebuilds a btree index that becomes a hash index", async () => {
    const fileSystem = await committed(`${TABLE}create index ix on public.slots (a);\n`);

    const result = await run(
      fileSystem,
      slots((t) => [{ columns: [t.a], method: "hash", name: "ix" }]),
    );

    expect(result.sql).toContain(`drop index "public"."ix";`);
    expect(result.sql).toContain(`create index "ix" on "public"."slots" using hash ("a");`);
  });

  it("keeps an index on a retyped column, which Postgres rebuilds itself", async () => {
    const fileSystem = await committed(
      `create table public.slots (a integer, b text);\ncreate index on public.slots (a, b);\n`,
    );
    const definition = defineDatabase({
      public: {
        slots: defineTable(
          (c) => ({ a: c.bigint(), b: c.text() }),
          (t) => ({ indexes: [{ columns: [t.a, t.b] }] }),
        ),
      },
    });

    const result = await run(fileSystem, definition);

    expect(result.sql).toContain(`alter table "public"."slots" alter column "a" type bigint;`);
    expect(result.sql).not.toContain("index");
  });
});
