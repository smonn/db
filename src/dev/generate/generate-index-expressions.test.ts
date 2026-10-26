import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import {
  defineDatabase,
  defineTable,
  type ColumnFactories,
} from "../../runtime/definition/index.ts";
import { writeMigration } from "../../runtime/internal/index.ts";
import { sql } from "../../runtime/query/index.ts";
import { generate } from "./generate.ts";
import { filesIn, memoryFileSystem } from "./memory-file-system.test-helper.ts";

const db = useTestDatabase();

beforeEach(async () => {
  await db.driver.execute(
    "drop schema if exists smonn_db cascade; drop schema public cascade; create schema public;",
  );
});

const TABLE = "create table public.slots (a integer, b text, c integer);\n";
const NOTHING = {
  path: "db/migrations/current.sql",
  sql: undefined,
  reset: true,
  hazards: [],
  hints: [],
};

const columns = (c: ColumnFactories) => ({ a: c.integer(), b: c.text(), c: c.integer() });

async function committed(body: string) {
  return memoryFileSystem({
    ...filesIn("db/migrations", [
      await writeMigration("000001-create-tables.sql", undefined, `${TABLE}${body}`),
    ]),
  });
}

type Definition = Parameters<typeof generate>[0]["definition"];

function run(fileSystem: ReturnType<typeof memoryFileSystem>, definition: Definition) {
  return generate({
    driver: db.driver,
    connect: db.connect,
    fileSystem,
    definition,
    migrations: "db/migrations",
  });
}

describe("generating an index with an expression key or a predicate", () => {
  it("creates both as Postgres deparses them, and verifies the Shadow database", async () => {
    const definition = defineDatabase({
      public: {
        slots: defineTable(columns, (t) => ({
          indexes: [
            { columns: [{ key: sql`lower(${t.b})`, order: "desc" }, t.a], name: "by_lower" },
            { columns: [sql`(${t.a} + ${t.c})`], name: "by_sum" },
            { columns: [t.a], unique: true, where: sql`${t.b} is not null`, name: "live" },
          ],
        })),
      },
    });

    const result = await run(memoryFileSystem(), definition);

    expect(result.sql).toContain(
      `create index "by_lower" on "public"."slots" ((lower(b)) desc, "a");`,
    );
    expect(result.sql).toContain(`create index "by_sum" on "public"."slots" ((a + c));`);
    expect(result.sql).toContain(
      `create unique index "live" on "public"."slots" ("a") where b IS NOT NULL;`,
    );
  });

  it("finds no difference from a migration that spells the same expression and predicate otherwise", async () => {
    const fileSystem = await committed(`create index by_lower on public.slots (  LOWER( b::text ) );
create index by_sum on public.slots (((a)+(c)));
create unique index live on public.slots (a) where (b)::text is not null and c > (0)::integer;
`);
    const definition = defineDatabase({
      public: {
        slots: defineTable(columns, (t) => ({
          indexes: [
            { columns: [sql`lower(${t.b})`], name: "by_lower" },
            { columns: [sql`${t.a} + ${t.c}`], name: "by_sum" },
            {
              columns: [t.a],
              unique: true,
              where: sql`${t.b} is not null and ${t.c} > 0`,
              name: "live",
            },
          ],
        })),
      },
    });

    expect(await run(fileSystem, definition)).toStrictEqual(NOTHING);
  });

  it("rebuilds an index whose expression or predicate changed", async () => {
    const fileSystem = await committed(`create index ix on public.slots (lower(b)) where c > 0;\n`);
    const expression = await run(
      fileSystem,
      defineDatabase({
        public: {
          slots: defineTable(columns, (t) => ({
            indexes: [{ columns: [sql`upper(${t.b})`], where: sql`${t.c} > 0`, name: "ix" }],
          })),
        },
      }),
    );
    const predicate = await run(
      fileSystem,
      defineDatabase({
        public: {
          slots: defineTable(columns, (t) => ({
            indexes: [{ columns: [sql`lower(${t.b})`], where: sql`${t.c} < 0`, name: "ix" }],
          })),
        },
      }),
    );

    expect(expression.sql).toContain(`drop index "public"."ix";`);
    expect(expression.sql).toContain("((upper(b))) where c > 0;");
    expect(predicate.sql).toContain(`drop index "public"."ix";`);
    expect(predicate.sql).toContain("where c < 0;");
  });

  it("drops an expression index that the Definition stops declaring", async () => {
    const fileSystem = await committed(`create index ix on public.slots (lower(b)) where c > 0;\n`);
    const definition = defineDatabase({ public: { slots: defineTable(columns) } });

    const result = await run(fileSystem, definition);

    expect(result.sql).toBe(`drop index "public"."ix";\n`);
  });
});
