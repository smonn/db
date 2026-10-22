import { describe, expect, it } from "vitest";
import { terminateBackendRunning, useTestDatabase } from "./test-database.test-helper.ts";

const db = useTestDatabase();

// postgres.js throws an uncaught TypeError when a statement goes to a connection whose backend
// has ended (#154), which fails the run.
describe("postgresJsDriver when the backend ends mid-statement", () => {
  const doomed = "select pg_sleep(30)";

  it("rejects a session with the statement's error", async () => {
    const failed = db.ownPool().session((session) => session.query(doomed));
    await Promise.all([
      expect(failed).rejects.toMatchObject({ code: "CONNECTION_CLOSED" }),
      terminateBackendRunning(db.driver, doomed),
    ]);
  });

  it("rejects a transaction with the statement's error", async () => {
    const failed = db.ownPool().transaction((tx) => tx.execute(doomed));
    await Promise.all([
      expect(failed).rejects.toMatchObject({ code: "CONNECTION_CLOSED" }),
      terminateBackendRunning(db.driver, doomed),
    ]);
  });
});

describe("postgresJsDriver when the backend ends during a rollback", () => {
  const doomed = "select pg_sleep(30)";

  it("rejects a transaction without resetting the dead connection", async () => {
    // The statement left running holds the connection, so the rollback waits behind it.
    const failed = db.ownPool().transaction((tx) => {
      tx.execute(doomed).catch(() => null);
      return Promise.reject(new Error("boom"));
    });
    await Promise.all([
      expect(failed).rejects.toMatchObject({ cause: { code: "CONNECTION_CLOSED" } }),
      terminateBackendRunning(db.driver, doomed),
    ]);
  });
});
