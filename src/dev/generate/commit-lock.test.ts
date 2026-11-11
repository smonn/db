import { beforeEach, describe, expect, it } from "vitest";
import {
  advisoryLocksHeld,
  backendPid,
  migrationLockHolderPid,
  untilMigrationLockAttempted,
  useTestDatabase,
  whileMigrationLockHeld,
} from "../../adapters/postgres-js/test-database.test-helper.ts";
import { defineDatabase, defineTable } from "../../runtime/definition/index.ts";
import { acquireMigrationLock } from "../../runtime/internal/index.ts";
import { migrate, type MigrateResult } from "../../runtime/migrator/index.ts";
import type { FileSystem } from "../../runtime/ports/index.ts";
import { commit } from "./commit.ts";
import { generate } from "./generate.ts";
import { memoryFileSystem } from "./memory-file-system.test-helper.ts";

const db = useTestDatabase();

const MIGRATIONS = "db/migrations";

const USERS = defineDatabase({ public: { users: defineTable((c) => ({ id: c.text() })) } });

beforeEach(async () => {
  await db.driver.execute(
    "drop schema if exists smonn_db cascade; drop schema public cascade; create schema public;",
  );
});

async function generated(): Promise<ReturnType<typeof memoryFileSystem>> {
  const fileSystem = memoryFileSystem();
  await generate({
    driver: db.driver,
    connect: db.connect,
    fileSystem,
    definition: USERS,
    migrations: MIGRATIONS,
  });
  return fileSystem;
}

function commitOptions(fileSystem: FileSystem): Parameters<typeof commit>[0] {
  return {
    driver: db.driver,
    fileSystem,
    migrations: MIGRATIONS,
    slug: "create-users",
    accept: [],
  };
}

describe("commit and the migrator's lock", () => {
  it("holds the lock through its transaction, so a migrate waits, then finds nothing left", async () => {
    const memory = await generated();
    const events: string[] = [];
    let migrating: Promise<MigrateResult | undefined> = Promise.resolve(undefined);
    let finishedEarly = false;
    // Commit's one write runs inside its transaction, after the Dev database check.
    const fileSystem: FileSystem = {
      ...memory,
      writeFile: async (path, content) => {
        await memory.writeFile(path, content);
        const holderPid = await migrationLockHolderPid(db.driver);
        migrating = migrate({
          driver: db.driver,
          source: {
            list: () => Promise.resolve([{ filename: "000001-create-users.sql", content }]),
          },
        }).then((result) => {
          events.push("migrate");
          return result;
        });
        await untilMigrationLockAttempted(db.driver, {
          holderPid,
          gaveUp: () => events.length > 0,
        });
        finishedEarly = events.length > 0;
      },
    };

    await commit(commitOptions(fileSystem));
    events.push("commit");
    const result = await migrating;

    expect(finishedEarly).toBe(false);
    expect(result).toStrictEqual({ applied: [] });
    expect(events).toStrictEqual(["commit", "migrate"]);
  });

  it("checks the Dev database under the lock, not before it", async () => {
    const fileSystem = await generated();
    let outcome: "pending" | "committed" | "refused" = "pending";
    let committing: Promise<unknown> = Promise.resolve();
    // The lock holder stands in for a runtime migrate that changes the Database before it lets go.
    await db.driver.session(async (holder) => {
      await acquireMigrationLock(holder);
      const holderPid = await backendPid(holder);
      const {
        rows: [row],
      } = await holder.query("select hash from smonn_db.current");
      await holder.execute("update smonn_db.current set hash = 'stale'");
      committing = commit(commitOptions(fileSystem)).then(
        () => {
          outcome = "committed";
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
      await holder.query("update smonn_db.current set hash = $1", [row!["hash"]]);
    });
    await committing;

    expect(outcome).toBe("committed");
  });

  it("releases both locks when the Dev database check refuses", async () => {
    const fileSystem = await generated();
    await db.driver.execute("update smonn_db.current set hash = 'stale'");

    await expect(commit(commitOptions(fileSystem))).rejects.toThrow("run generate first");

    expect(await advisoryLocksHeld(db.driver)).toBe(0);
  });
});

describe("commit and a lock wait that stops", () => {
  it("rejects when the signal aborts, and leaves the files and the Dev lock alone", async () => {
    const fileSystem = await generated();
    const controller = new AbortController();

    await whileMigrationLockHeld(db.driver, async () => {
      const committing = commit({ ...commitOptions(fileSystem), signal: controller.signal });
      await untilMigrationLockAttempted(db.driver);
      controller.abort();
      await expect(committing).rejects.toThrow("stopped waiting for the migrator's lock");
    });

    expect([...fileSystem.files.keys()]).toStrictEqual(["db/migrations/current.sql"]);
    expect(await advisoryLocksHeld(db.driver)).toBe(0);
  });
});
