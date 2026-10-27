import { describe, expect, it, vi } from "vitest";
import type { Queryable } from "../ports/index.ts";
import {
  useTestDatabase,
  whileMigrationLockHeld,
} from "../../adapters/postgres-js/test-database.test-helper.ts";
import { acquireMigrationLock } from "./migration-lock.ts";

const db = useTestDatabase();

describe("acquireMigrationLock", () => {
  it("polls again when a poll returns no row", async () => {
    const query = vi
      .fn<Queryable["query"]>()
      .mockResolvedValueOnce({ rows: [], count: 0 })
      .mockResolvedValueOnce({ rows: [{ locked: false }], count: 1 })
      .mockResolvedValueOnce({ rows: [{ locked: true }], count: 1 });

    await acquireMigrationLock(
      { query, execute: vi.fn<Queryable["execute"]>() },
      { intervalMs: 1 },
    );

    expect(query).toHaveBeenCalledTimes(3);
  });

  it("polls while another session holds the lock, without queuing for it, then takes it", async () => {
    const held = await whileMigrationLockHeld(db.driver, () =>
      db.driver.session((session) => acquireMigrationLock(session, { intervalMs: 10 })),
    );

    expect(held.finishedWhileHeld).toBe(false);
    expect(held.queued).toBe(0);
  });
});
