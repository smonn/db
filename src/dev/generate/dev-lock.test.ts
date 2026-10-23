import { describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { withDevLock } from "./dev-lock.ts";

const db = useTestDatabase();

describe("withDevLock", () => {
  // The first test times out while it holds the lock; the second runs after it.
  it.fails("keeps the lock while a test hangs", { timeout: 200 }, async () => {
    await expect(
      withDevLock(db.driver, "generate", () => new Promise<string>(() => {})),
    ).resolves.toBe("never");
  });

  it("takes the lock after a test timed out holding it", async () => {
    await expect(withDevLock(db.driver, "generate", () => Promise.resolve("ran"))).resolves.toBe(
      "ran",
    );
  });
});
