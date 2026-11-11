import { describe, expect, it, vi } from "vitest";
import type { Queryable } from "../ports/index.ts";
import {
  untilMigrationLockAttempted,
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

  it("waits the interval between polls", async () => {
    vi.useFakeTimers();
    try {
      const query = vi
        .fn<Queryable["query"]>()
        .mockResolvedValueOnce({ rows: [{ locked: false }], count: 1 })
        .mockResolvedValueOnce({ rows: [{ locked: true }], count: 1 });
      const taken = acquireMigrationLock(
        { query, execute: vi.fn<Queryable["execute"]>() },
        { intervalMs: 500 },
      );

      await vi.advanceTimersByTimeAsync(499);
      expect(query).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await taken;
      expect(query).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops waiting when the signal aborts, naming the lock and keeping the reason", async () => {
    vi.useFakeTimers();
    try {
      const query = vi
        .fn<Queryable["query"]>()
        .mockResolvedValue({ rows: [{ locked: false }], count: 1 });
      const controller = new AbortController();
      const reason = new Error("interrupted");
      const waiting = acquireMigrationLock(
        { query, execute: vi.fn<Queryable["execute"]>() },
        { intervalMs: 500, signal: controller.signal },
      );
      const failures: unknown[] = [];
      void waiting.catch((error: unknown) => failures.push(error));

      await vi.advanceTimersByTimeAsync(10);
      controller.abort(reason);
      // Well inside the poll interval: the sleep ends on the abort, not when the timer fires.
      await vi.advanceTimersByTimeAsync(1);

      expect(failures).toHaveLength(1);
      expect(failures[0]).toBeInstanceOf(Error);
      expect(failures[0]).toHaveProperty("message", "stopped waiting for the migrator's lock");
      expect(failures[0]).toHaveProperty("cause", reason);
      expect(query).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("doesn't poll when the signal is already aborted", async () => {
    const query = vi.fn<Queryable["query"]>();

    await expect(
      acquireMigrationLock(
        { query, execute: vi.fn<Queryable["execute"]>() },
        { signal: AbortSignal.abort() },
      ),
    ).rejects.toThrow("stopped waiting for the migrator's lock");

    expect(query).not.toHaveBeenCalled();
  });

  it("stops at once when the signal aborts during a poll", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const query = vi.fn<Queryable["query"]>().mockImplementation(() => {
        controller.abort();
        return Promise.resolve({ rows: [{ locked: false }], count: 1 });
      });
      const failures: unknown[] = [];
      void acquireMigrationLock(
        { query, execute: vi.fn<Queryable["execute"]>() },
        { intervalMs: 60_000, signal: controller.signal },
      ).catch((error: unknown) => failures.push(error));

      await vi.advanceTimersByTimeAsync(1);

      expect(failures).toHaveLength(1);
      expect(failures[0]).toHaveProperty("message", "stopped waiting for the migrator's lock");
      expect(query).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("takes the lock when the signal never aborts", async () => {
    const query = vi
      .fn<Queryable["query"]>()
      .mockResolvedValue({ rows: [{ locked: true }], count: 1 });

    await acquireMigrationLock(
      { query, execute: vi.fn<Queryable["execute"]>() },
      { signal: new AbortController().signal },
    );

    expect(query).toHaveBeenCalledTimes(1);
  });

  it("stops waiting on a lock another session holds", async () => {
    const controller = new AbortController();
    await whileMigrationLockHeld(db.driver, async () => {
      const waiting = db.driver.session((session) =>
        acquireMigrationLock(session, { intervalMs: 10, signal: controller.signal }),
      );
      await untilMigrationLockAttempted(db.driver);
      controller.abort();
      await expect(waiting).rejects.toThrow("stopped waiting for the migrator's lock");
    });
  });

  it("polls while another session holds the lock, without queuing for it, then takes it", async () => {
    const held = await whileMigrationLockHeld(db.driver, () =>
      db.driver.session((session) => acquireMigrationLock(session, { intervalMs: 10 })),
    );

    expect(held.finishedWhileHeld).toBe(false);
    expect(held.queued).toBe(0);
  });
});
