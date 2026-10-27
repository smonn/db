import { describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { withDevLock } from "./dev-lock.ts";

const db = useTestDatabase();

describe("withDevLock", () => {
  // The first test ends while its session holds the lock; the second runs after it. A timeout
  // would end the test whether or not the session had taken the lock yet, so the test waits on
  // the holder instead and ends on its own.
  it("keeps the lock while a test ends holding it", async () => {
    const held = Promise.withResolvers<void>();
    // The session stays pending until the test helper terminates its backend in afterEach.
    const running = withDevLock(db.driver, "generate", () => {
      held.resolve();
      return new Promise<string>(() => {});
    });
    // Racing surfaces a rejection from before the lock was taken, such as a stale holder.
    await expect(Promise.race([held.promise.then(() => "held"), running])).resolves.toBe("held");
  });

  it("takes the lock after a test ended holding it", async () => {
    await expect(withDevLock(db.driver, "generate", () => Promise.resolve("ran"))).resolves.toBe(
      "ran",
    );
  });
});
