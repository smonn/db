import { describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { migrate } from "../../runtime/migrator/index.ts";
import { memoryFileSystem } from "./memory-file-system.test-helper.ts";
import { reset } from "./reset.ts";

const db = useTestDatabase();

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
    let migrating: Promise<unknown> = Promise.resolve();
    await db.driver.transaction(async (gate) => {
      await gate.execute("lock table public.gate in share mode");
      resetting = reset({
        driver: db.driver,
        fileSystem: memoryFileSystem(),
        migrations: "db/migrations",
        erase: true,
      }).then(() => events.push("reset"));
      await untilBlockedOnGate();
      migrating = migrate({
        driver: db.driver,
        source: { list: () => Promise.resolve([]) },
      }).then(() => events.push("migrate"));
      await sleep(250);
      expect(events).toStrictEqual([]);
    });
    await Promise.all([resetting, migrating]);

    expect(events).toStrictEqual(["reset", "migrate"]);
  });
});
