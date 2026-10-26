import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import {
  defineDatabase,
  defineTable,
  type ColumnFactories,
  type ColumnRefs,
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

const columns = (c: ColumnFactories) => ({ a: c.text(), b: c.text(), c: c.text() });

type Refs = ColumnRefs<ReturnType<typeof columns>>;
type AnyRef = Refs[keyof Refs];
type Entry = {
  readonly columns: readonly [AnyRef, AnyRef, ...AnyRef[]];
  readonly name?: string;
  readonly nullsNotDistinct?: boolean;
};

/** A `slots` table whose second callback declares the unique entries `entries` returns. */
function slots(entries: (t: Refs) => readonly Entry[] = () => []) {
  return defineDatabase({
    public: { slots: defineTable(columns, (t) => ({ unique: entries(t) })) },
  });
}

const TABLE = "create table public.slots (a text, b text, c text);\n";
const NOTHING = { path: CURRENT, sql: undefined, reset: true, hazards: [], hints: [] };

describe("generating a multi-column unique constraint", () => {
  it("creates a table with it and verifies the Shadow database matches", async () => {
    const result = await run(
      memoryFileSystem(),
      slots((t) => [
        { columns: [t.b, t.a] },
        { columns: [t.a, t.b, t.c], nullsNotDistinct: true, name: "uq" },
      ]),
    );

    expect(result.sql).toContain(
      `alter table "public"."slots" add constraint "slots_b_a_key" unique ("b", "a");`,
    );
    expect(result.sql).toContain(
      `alter table "public"."slots" add constraint "uq" unique nulls not distinct ("a", "b", "c");`,
    );
    expect(result.hazards).toStrictEqual([]);
  });

  it("finds no difference from a Committed migration that adds it with Postgres's name", async () => {
    const fileSystem = await committed(`${TABLE}alter table public.slots add unique (b, a);
alter table public.slots add constraint uq unique nulls not distinct (a, b, c);
`);

    const result = await run(
      fileSystem,
      slots((t) => [
        { columns: [t.b, t.a] },
        { columns: [t.a, t.b, t.c], nullsNotDistinct: true, name: "uq" },
      ]),
    );

    expect(result).toStrictEqual(NOTHING);
  });

  it("adds one to an existing table with the lock Hazard, and verifies the Shadow database", async () => {
    const result = await run(
      await committed(TABLE),
      slots((t) => [{ columns: [t.a, t.b] }]),
    );

    const statement = `alter table "public"."slots" add constraint "slots_a_b_key" unique ("a", "b");`;
    expect(result.sql).toBe(`-- hazard: access_exclusive_lock\n${statement}\n`);
    expect(result.hazards).toStrictEqual([{ kind: "access_exclusive_lock", statement }]);
  });

  it("drops one that the Definition stops declaring", async () => {
    const fileSystem = await committed(`${TABLE}alter table public.slots add unique (a, b);\n`);

    const result = await run(fileSystem, slots());

    expect(result.sql).toBe(`alter table "public"."slots" drop constraint "slots_a_b_key";\n`);
  });

  it("rebuilds one whose column list changed, and verifies the Shadow database", async () => {
    const fileSystem = await committed(`${TABLE}alter table public.slots add unique (a, b);\n`);

    const result = await run(
      fileSystem,
      slots((t) => [{ columns: [t.a, t.c], name: "slots_a_b_key" }]),
    );

    expect(result.sql).toContain(`alter table "public"."slots" drop constraint "slots_a_b_key";`);
    expect(result.sql).toContain(
      `alter table "public"."slots" add constraint "slots_a_b_key" unique ("a", "c");`,
    );
  });

  it("rebuilds one that gains NULLS NOT DISTINCT, and one whose columns swap order", async () => {
    const fileSystem = await committed(`${TABLE}alter table public.slots add unique (a, b);\n`);

    const gained = await run(
      fileSystem,
      slots((t) => [{ columns: [t.a, t.b], nullsNotDistinct: true }]),
    );
    expect(gained.sql).toContain(`unique nulls not distinct ("a", "b");`);

    const swapped = await run(
      fileSystem,
      slots((t) => [{ columns: [t.b, t.a], name: "slots_a_b_key" }]),
    );
    expect(swapped.sql).toContain(`add constraint "slots_a_b_key" unique ("b", "a");`);
  });
});
