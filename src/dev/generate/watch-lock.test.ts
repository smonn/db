import { describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { withDevLock } from "./dev-lock.ts";
import { WATCH_LOCK_KEY, WatcherLockedError, withWatchLock } from "./watch-lock.ts";

const db = useTestDatabase();

describe("withWatchLock", () => {
  it("refuses a second watcher while the first holds the lock, and frees it after", async () => {
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const first = withWatchLock(db.driver, () => {
      held.resolve();
      return release.promise;
    });
    await held.promise;

    const second = withWatchLock(db.driver, () => Promise.resolve());
    await expect(second).rejects.toThrow(WatcherLockedError);
    await expect(second).rejects.toThrow(
      `can't watch: another generate --watch holds advisory lock ${WATCH_LOCK_KEY} on the Dev database`,
    );
    await expect(withDevLock(db.driver, "generate", () => Promise.resolve("ran"))).resolves.toBe(
      "ran",
    );
    release.resolve();
    await first;
    await expect(withWatchLock(db.driver, () => Promise.resolve("ran"))).resolves.toBe("ran");
  });
});
