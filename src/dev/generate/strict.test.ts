import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { defineDatabase, defineTable } from "../../runtime/definition/index.ts";
import { commit } from "./commit.ts";
import { generate } from "./generate.ts";
import { memoryFileSystem } from "./memory-file-system.test-helper.ts";
import { StrictLeftoverError } from "./shadow-diff.ts";

const db = useTestDatabase();

const MIGRATIONS = "db/migrations";
const CURRENT = `${MIGRATIONS}/current.sql`;
const CONFIG = "db/smonndb.config.ts";

const definition = defineDatabase({
  public: { users: defineTable((c) => ({ id: c.text() })) },
});

// Creates nothing, so the Shadow stays unlike the Definition.
const LEFTOVER_EDIT = "select 1;\n";
const MATCHING_EDIT = 'create table "public"."users" (\n  "id" text\n);\n-- by hand\n';

const REFUSAL = `error: current.sql leaves a difference from the Definition (strict mode, ${CONFIG}):
the Current migration leaves the Shadow database unlike the Definition database:
  table "public"."users" is missing from the Shadow database
  column "public"."users"."id" is missing from the Shadow database
fix the hand edit in ${CURRENT}, or set strict: false in ${CONFIG}`;

beforeEach(async () => {
  await db.driver.execute(
    "drop schema if exists smonn_db cascade; drop schema public cascade; create schema public;",
  );
});

function run(fileSystem: ReturnType<typeof memoryFileSystem>, strict?: { config: string }) {
  return generate({
    driver: db.driver,
    connect: db.connect,
    fileSystem,
    definition,
    migrations: MIGRATIONS,
    ...(strict === undefined ? {} : { strict }),
  });
}

describe("generate in strict mode", () => {
  it("refuses a hand edit's leftover before it touches the Dev database", async () => {
    const fileSystem = memoryFileSystem({ [CURRENT]: LEFTOVER_EDIT });

    const refusal = await run(fileSystem, { config: CONFIG }).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(StrictLeftoverError);
    expect(refusal).toHaveProperty("message", REFUSAL);
    expect(refusal).toHaveProperty("leftover", REFUSAL.split("\n").slice(1, 4).join("\n"));
    expect(fileSystem.files.get(CURRENT)).toBe(LEFTOVER_EDIT);
    const { rows } = await db.driver.query(
      "select count(*)::int as n from pg_namespace where nspname = 'smonn_db'",
    );
    expect(rows).toStrictEqual([{ n: 0 }]);
  });

  it("leaves commit to refuse the edit, since the Dev database never replayed it", async () => {
    const fileSystem = memoryFileSystem({ [CURRENT]: LEFTOVER_EDIT });
    await expect(run(fileSystem, { config: CONFIG })).rejects.toThrow("strict mode");
    await run(memoryFileSystem(), { config: CONFIG });

    await expect(
      commit({ driver: db.driver, fileSystem, migrations: MIGRATIONS, slug: "edit", accept: [] }),
    ).rejects.toThrow(
      `the Dev database hasn't replayed ${CURRENT} as it reads now; run generate first`,
    );
  });

  it("keeps a hand edit that leaves nothing", async () => {
    const fileSystem = memoryFileSystem({ [CURRENT]: MATCHING_EDIT });

    const result = await run(fileSystem, { config: CONFIG });

    expect(result.sql).toBe(MATCHING_EDIT);
    expect(result).not.toHaveProperty("leftover");
  });

  it("generates as usual when there is no hand edit", async () => {
    const result = await run(memoryFileSystem(), { config: CONFIG });

    expect(result.file).toBe("written");
  });

  it("still returns a hand edit's leftover as a warning when strict is off", async () => {
    const fileSystem = memoryFileSystem({ [CURRENT]: LEFTOVER_EDIT });

    const result = await run(fileSystem);

    expect(result.leftover).toContain('table "public"."users" is missing');
    expect(result.devDatabase).toStrictEqual({ kind: "reset" });
  });
});
