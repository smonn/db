import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { defineDatabase, defineTable } from "../../runtime/definition/index.ts";
import { commit } from "./commit.ts";
import { generate } from "./generate.ts";
import { memoryFileSystem, type MemoryFileSystem } from "./memory-file-system.test-helper.ts";

const db = useTestDatabase();

const MIGRATIONS = "db/migrations";
const CURRENT = `${MIGRATIONS}/current.sql`;
const HAZARD = '-- hazard: data_loss\ndrop table "public"."users";\n';

const users = defineDatabase({ public: { users: defineTable((c) => ({ id: c.text() })) } });

function generateInto(fileSystem: MemoryFileSystem): Promise<unknown> {
  return generate({
    driver: db.driver,
    connect: db.connect,
    fileSystem,
    definition: users,
    migrations: MIGRATIONS,
  });
}

/** A Current migration with a hand-written Hazard, which the Dev database has replayed. */
async function withHazard(): Promise<MemoryFileSystem> {
  const fileSystem = memoryFileSystem();
  await generateInto(fileSystem);
  fileSystem.files.set(CURRENT, `${fileSystem.files.get(CURRENT)}${HAZARD}`);
  await generateInto(fileSystem);
  return fileSystem;
}

async function currentHashes(): Promise<unknown[]> {
  const { rows } = await db.driver.query("select hash from smonn_db.current");
  return rows.map((row) => row["hash"]);
}

beforeEach(async () => {
  await db.driver.execute(
    "drop schema if exists smonn_db cascade; drop schema public cascade; create schema public;",
  );
});

describe("commit Hazards", () => {
  it("refuses a Hazard kind outside accept, and writes nothing", async () => {
    const fileSystem = await withHazard();
    const before = new Map(fileSystem.files);
    const hashesBefore = await currentHashes();

    await expect(
      commit({
        driver: db.driver,
        fileSystem,
        migrations: MIGRATIONS,
        slug: "create-users",
        accept: [],
      }),
    ).rejects.toThrow(
      [
        "current.sql has Hazards that --accept doesn't name:",
        '  data_loss: drop table "public"."users";',
        "to commit anyway, pass --accept data_loss",
      ].join("\n"),
    );
    expect(fileSystem.files).toStrictEqual(before);
    const { rows: recorded } = await db.driver.query("select sequence from smonn_db.migrations");
    expect(await currentHashes()).toStrictEqual(hashesBefore);
    expect(recorded).toHaveLength(0);
  });

  it("refuses a body whose only Hazards are unknown kinds, and writes nothing", async () => {
    const fileSystem = await withHazard();
    fileSystem.files.set(
      CURRENT,
      `${fileSystem.files.get(CURRENT)}`.replace("-- hazard: data_loss", "-- hazard: dataloss"),
    );
    const before = new Map(fileSystem.files);

    await expect(
      commit({
        driver: db.driver,
        fileSystem,
        migrations: MIGRATIONS,
        slug: "create-users",
        accept: ["data_loss", "rewrite", "access_exclusive_lock"],
      }),
    ).rejects.toThrow('unknown Hazard kind "dataloss" in current.sql; fix or delete the comment');
    expect(fileSystem.files).toStrictEqual(before);
  });

  it("commits once accept names the kind, and keeps the comment in the migration", async () => {
    const fileSystem = await withHazard();

    const { path } = await commit({
      driver: db.driver,
      fileSystem,
      migrations: MIGRATIONS,
      slug: "create-users",
      accept: ["data_loss"],
    });

    expect(fileSystem.files.get(path)).toContain(HAZARD);
  });
});
