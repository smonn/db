import { describe, expect, it } from "vitest";
import {
  untilMigrationLockAttempted,
  useTestDatabase,
  whileMigrationLockHeld,
} from "../../adapters/postgres-js/test-database.test-helper.ts";
import { memoryFileSystem } from "./memory-file-system.test-helper.ts";
import { reset } from "./reset.ts";

const db = useTestDatabase();

describe("reset and a lock wait that stops", () => {
  it("rejects when the signal aborts, before it wipes anything", async () => {
    await db.driver.execute(
      "drop schema if exists smonn_db cascade; drop schema public cascade; create schema public; create table public.leftover (id int)",
    );
    const controller = new AbortController();

    await whileMigrationLockHeld(db.driver, async () => {
      const resetting = reset({
        driver: db.driver,
        fileSystem: memoryFileSystem(),
        migrations: "db/migrations",
        erase: true,
        signal: controller.signal,
      });
      await untilMigrationLockAttempted(db.driver);
      controller.abort();
      await expect(resetting).rejects.toThrow("stopped waiting for the migrator's lock");
    });

    const { rows } = await db.driver.query("select to_regclass('public.leftover') as found");
    expect(rows[0]?.["found"]).toBe("leftover");
  });
});
