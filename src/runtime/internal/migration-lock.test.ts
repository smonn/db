import { describe, expect, it } from "vitest";
import {
  useTestDatabase,
  whileMigrationLockHeld,
} from "../../adapters/postgres-js/test-database.test-helper.ts";
import { acquireMigrationLock } from "./migration-lock.ts";

const db = useTestDatabase();

describe("acquireMigrationLock", () => {
  it("polls while another session holds the lock, without queuing for it, then takes it", async () => {
    const held = await whileMigrationLockHeld(db.driver, () =>
      db.driver.session((session) => acquireMigrationLock(session, { intervalMs: 10 })),
    );

    expect(held.finishedWhileHeld).toBe(false);
    expect(held.queued).toBe(0);
  });
});
