import { describe, expect, it } from "vitest";
import {
  advisoryLocksHeld,
  backendPid,
  migrationLockHolderPid,
  untilMigrationLockAttempted,
  useTestDatabase,
} from "../../adapters/postgres-js/test-database.test-helper.ts";
import { acquireMigrationLock, writeMigration } from "../../runtime/internal/index.ts";
import { migrate, type MigrateResult } from "../../runtime/migrator/index.ts";
import { filesIn, memoryFileSystem } from "./memory-file-system.test-helper.ts";
import { reset } from "./reset.ts";

const db = useTestDatabase();

const MIGRATIONS = "db/migrations";

const CREATE_WIDGETS = await writeMigration(
  "000001-create-widgets.sql",
  undefined,
  "create table public.widgets (id int);\n",
);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// A lock on public.gate holds the wipe's `drop schema public`, and so reset, after it took the
// migrator's lock. A relation lock keeps the wait out of the advisory-lock counts of other files.
async function untilBlockedOnGate(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- each poll waits on the one before it.
    const { rows } = await db.driver.query(
      "select count(*)::int as n from pg_locks where locktype = 'relation' and not granted and relation = 'public.gate'::regclass",
    );
    if (Number(rows[0]?.["n"]) > 0) return;
    // oxlint-disable-next-line eslint/no-await-in-loop -- see above.
    await sleep(10);
  }
  throw new Error("reset never reached the gate");
}

describe("reset and the migrator's lock", () => {
  it("holds the lock for the whole reset, so a migrate waits, then finds nothing left", async () => {
    await db.driver.execute(
      "drop schema if exists smonn_db cascade; drop schema public cascade; create schema public; create table public.gate (id int)",
    );
    const events: string[] = [];
    let resetting: Promise<unknown> = Promise.resolve();
    let migrating: Promise<MigrateResult | undefined> = Promise.resolve(undefined);
    await db.driver.transaction(async (gate) => {
      await gate.execute("lock table public.gate in share mode");
      resetting = reset({
        driver: db.driver,
        fileSystem: memoryFileSystem(filesIn(MIGRATIONS, [CREATE_WIDGETS])),
        migrations: MIGRATIONS,
        erase: true,
      }).then(() => events.push("reset"));
      await untilBlockedOnGate();
      const holderPid = await migrationLockHolderPid(db.driver);
      migrating = migrate({
        driver: db.driver,
        source: { list: () => Promise.resolve([CREATE_WIDGETS]) },
      }).then((result) => {
        events.push("migrate");
        return result;
      });
      await untilMigrationLockAttempted(db.driver, { holderPid, gaveUp: () => events.length > 0 });
      expect(events).toStrictEqual([]);
    });
    await resetting;

    expect(await migrating).toStrictEqual({ applied: [] });
    expect(events).toStrictEqual(["reset", "migrate"]);
  });
});

const DIVIDES = await writeMigration("000001-divide.sql", undefined, "select 1 / 0;\n");
const OPENS = await writeMigration("000001-open.sql", undefined, "select 1;\n", {
  noTransaction: true,
});
const DIVIDES_AFTER_OPEN = await writeMigration("000002-divide.sql", OPENS.hash, "select 1 / 0;\n");

describe("a reset that fails", () => {
  it.each([
    ["a transactional file", [DIVIDES]],
    ["a file after a no-transaction one", [OPENS, DIVIDES_AFTER_OPEN]],
  ])("releases the migrator's lock when %s raises", async (_name, files) => {
    await db.driver.execute("drop schema if exists smonn_db cascade");

    await expect(
      reset({
        driver: db.driver,
        fileSystem: memoryFileSystem(filesIn(MIGRATIONS, files)),
        migrations: MIGRATIONS,
        erase: true,
      }),
    ).rejects.toThrow("division by zero");

    expect(await advisoryLocksHeld(db.driver)).toBe(0);
  });
});

describe("reset and the Dev database check", () => {
  it("checks the Database under the migrator's lock, not before it", async () => {
    await db.driver.execute(
      "drop schema if exists smonn_db cascade; drop schema public cascade; create schema public; create table public.leftover (id int)",
    );
    let outcome: "pending" | "reset" | "refused" = "pending";
    let resetting: Promise<unknown> = Promise.resolve();
    // The lock holder stands in for a runtime migrate that changes the Database before it lets go.
    await db.driver.session(async (holder) => {
      await acquireMigrationLock(holder);
      const holderPid = await backendPid(holder);
      resetting = reset({
        driver: db.driver,
        fileSystem: memoryFileSystem(),
        migrations: MIGRATIONS,
      }).then(
        () => {
          outcome = "reset";
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
    await resetting;

    expect(outcome).toBe("reset");
  });
});
