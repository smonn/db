import { describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { acquireMigrationLock } from "./migration-lock.ts";

const db = useTestDatabase();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitingOnAdvisoryLock(): Promise<number> {
  const { rows } = await db.driver.query(
    "select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted",
  );
  return Number(rows[0]?.["n"]);
}

describe("acquireMigrationLock", () => {
  it("polls while another session holds the lock, without queuing for it, then takes it", async () => {
    let settled = false;
    let queued = -1;
    await db.driver.session(async (holder) => {
      await acquireMigrationLock(holder);
      const waiter = db.driver.session(async (session) => {
        await acquireMigrationLock(session, { intervalMs: 10 });
        settled = true;
      });
      await sleep(100);
      queued = await waitingOnAdvisoryLock();
      expect(settled).toBe(false);
      await holder.query("select pg_advisory_unlock_all()");
      await waiter;
    });

    expect(queued).toBe(0);
    expect(settled).toBe(true);
  });
});
