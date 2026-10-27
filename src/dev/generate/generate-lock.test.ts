import { beforeEach, describe, expect, it } from "vitest";
import {
  advisoryLocksHeld,
  backendPid,
  untilMigrationLockAttempted,
  useTestDatabase,
} from "../../adapters/postgres-js/test-database.test-helper.ts";
import { defineDatabase, defineTable } from "../../runtime/definition/index.ts";
import { acquireMigrationLock, writeMigration } from "../../runtime/internal/index.ts";
import { migrate } from "../../runtime/migrator/index.ts";
import type { Connect } from "../../runtime/ports/index.ts";
import { DEV_LOCK_KEY } from "./dev-lock.ts";
import { generate } from "./generate.ts";
import { generateOptions } from "./generate-options.test-helper.ts";
import { filesIn, memoryFileSystem } from "./memory-file-system.test-helper.ts";

const db = useTestDatabase();

const MIGRATIONS = "db/migrations";

const CREATE_WIDGETS = await writeMigration(
  "000001-create-widgets.sql",
  undefined,
  "create table public.widgets (id int);\n",
);

const WIDGETS = defineDatabase({
  public: { widgets: defineTable((c) => ({ id: c.integer() })) },
});

const NOTHING = defineDatabase({});

const DIVIDES = await writeMigration("000001-divide.sql", undefined, "select 1 / 0;\n");

beforeEach(async () => {
  await db.driver.execute(
    "drop schema if exists smonn_db cascade; drop schema public cascade; create schema public",
  );
});

/** Runs `before` once, on the first connection generate opens, which is after its first check. */
function beforeFirstConnect(before: () => Promise<void>): Connect {
  let pending: Promise<void> | undefined = undefined;
  return async (database) => {
    pending ??= before();
    await pending;
    return db.connect(database);
  };
}

describe("generate and the migrator's lock", () => {
  it("checks the Dev database under the lock, not before it", async () => {
    await db.driver.execute("create table public.leftover (id int)");
    let outcome: "pending" | "generated" | "refused" = "pending";
    let generating: Promise<unknown> = Promise.resolve();
    // The lock holder stands in for a runtime migrate that changes the Database before it lets go.
    await db.driver.session(async (holder) => {
      await acquireMigrationLock(holder);
      const holderPid = await backendPid(holder);
      generating = generate(generateOptions(db, memoryFileSystem(), NOTHING)).then(
        () => {
          outcome = "generated";
        },
        () => {
          outcome = "refused";
        },
      );
      await untilMigrationLockAttempted(db.driver, {
        holderPid,
        gaveUp: () => outcome !== "pending",
      });
      expect(outcome).toBe("pending");
      await holder.execute("drop table public.leftover");
    });
    await generating;

    expect(outcome).toBe("generated");
  });

  it("holds the lock through the Shadow work and the reset, so a migrate waits for them", async () => {
    const events: string[] = [];
    let migrating: Promise<unknown> = Promise.resolve();
    let finishedEarly = false;
    // Opens after the check, while generate works in the Shadow, and tries to migrate the Dev database.
    const connect = beforeFirstConnect(async () => {
      const holderPid = await devLockPid();
      migrating = migrate({
        driver: db.driver,
        source: { list: () => Promise.resolve([CREATE_WIDGETS]) },
      }).then(() => events.push("migrate"));
      await untilMigrationLockAttempted(db.driver, { holderPid, gaveUp: () => events.length > 0 });
      finishedEarly = events.length > 0;
    });
    const fileSystem = memoryFileSystem(filesIn(MIGRATIONS, [CREATE_WIDGETS]));

    const result = await generate({ ...generateOptions(db, fileSystem, WIDGETS), connect });
    events.push("generate");
    await migrating;

    expect(result.reset).toBe(true);
    expect(finishedEarly).toBe(false);
    expect(events).toStrictEqual(["generate", "migrate"]);
  });

  it.each([
    [
      "the Dev database check refuses",
      async () => {
        await db.driver.execute("create table public.leftover (id int)");
        return memoryFileSystem();
      },
      "isn't a Dev database",
    ],
    [
      "a Committed migration fails",
      () => Promise.resolve(memoryFileSystem(filesIn(MIGRATIONS, [DIVIDES]))),
      "division by zero",
    ],
  ])("releases both locks when %s", async (_name, setUp, message) => {
    const fileSystem = await setUp();

    await expect(generate(generateOptions(db, fileSystem, NOTHING))).rejects.toThrow(message);

    expect(await advisoryLocksHeld(db.driver)).toBe(0);
  });
});

/** The backend that holds the Dev lock, which is the one generate's run goes on. */
async function devLockPid(): Promise<number> {
  const { rows } = await db.driver.query(
    `select pid from pg_locks where locktype = 'advisory' and granted and ((classid::bigint << 32) | objid::bigint) = ${DEV_LOCK_KEY}`,
  );
  return Number(rows[0]?.["pid"]);
}
