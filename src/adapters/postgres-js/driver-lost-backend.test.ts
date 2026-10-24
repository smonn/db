import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Driver, Queryable } from "../../runtime/ports/index.ts";
import { startTcpProxy, type TcpProxy } from "./tcp-proxy.test-helper.ts";
import {
  backendRunning,
  terminateBackendRunning,
  useTestDatabase,
} from "./test-database.test-helper.ts";

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

// postgres.js rejects the statement with the plain socket error, and a statement sent after it
// crashes the process or never settles (#221).
describe("postgresJsDriver when the reserved connection's socket resets mid-statement", () => {
  const reset = { code: "ECONNRESET" };
  const served = { rows: [{ one: 1 }] };
  let proxy: TcpProxy | undefined;
  let pool: Driver;
  let doomed: string;
  let tests = 0;

  beforeAll(async () => {
    proxy = await startTcpProxy(db.url);
  });
  beforeEach(() => {
    // The backend outlives the reset, so each test waits on a statement of its own.
    tests += 1;
    doomed = `select pg_sleep(30) as reset_${tests}`;
    if (proxy === undefined) {
      throw new Error("the proxy did not start");
    }
    pool = db.ownPool({ url: proxy.url });
  });
  afterAll(() => proxy?.close());

  async function resetOnceRunning(): Promise<void> {
    await backendRunning(db.driver, doomed);
    proxy?.resetAll();
    await terminateBackendRunning(db.driver, doomed);
  }

  it("rejects a session with the socket's error", async () => {
    const failed = pool.session((session) => session.query(doomed));
    await Promise.all([expect(failed).rejects.toMatchObject(reset), resetOnceRunning()]);
    await expect(pool.query("select 1 as one")).resolves.toMatchObject(served);
  });

  it("rejects a transaction with the socket's error", async () => {
    const failed = pool.transaction((tx) => tx.execute(doomed));
    await Promise.all([expect(failed).rejects.toMatchObject(reset), resetOnceRunning()]);
    await expect(pool.query("select 1 as one")).resolves.toMatchObject(served);
  });

  it("rejects a later statement on the lost connection without sending it", async () => {
    const failed = pool.session(async (session) => {
      await session.query(doomed).catch(() => null);
      await session.query("select 1");
    });
    await Promise.all([expect(failed).rejects.toMatchObject(reset), resetOnceRunning()]);
    await expect(pool.query("select 1 as one")).resolves.toMatchObject(served);
  });

  it("resolves a session whose fn caught the socket's error", async () => {
    const caught = pool.session(async (session) => {
      await session.query(doomed).catch(() => null);
      return "caught";
    });
    await Promise.all([expect(caught).resolves.toBe("caught"), resetOnceRunning()]);
    await expect(pool.query("select 1 as one")).resolves.toMatchObject(served);
  });
});

// A pool of one connection hangs the count if the transaction leaked its connection.
describe("postgresJsDriver when fn throws a connection error that isn't its connection's", () => {
  const doomed = "select pg_sleep(30) as foreign";
  const writes = "select count(*)::int as writes from lost_backend_writes";

  beforeAll(() => db.driver.execute("create table lost_backend_writes (id int)"));

  async function writesAfterRollback(error: unknown): Promise<unknown> {
    const pool = db.ownPool({ max: 1 });
    const writeThenThrow = async (tx: Queryable): Promise<never> => {
      await tx.execute("insert into lost_backend_writes values (1)");
      throw error;
    };
    // The session's reset would roll back too, so check the session before it ends.
    const afterTransaction = pool.session(async (session) => {
      await expect(session.transaction(writeThenThrow)).rejects.toBe(error);
      return session.query(writes);
    });
    await expect(afterTransaction).resolves.toMatchObject({ rows: [{ writes: 0 }] });
    await expect(pool.transaction(writeThenThrow)).rejects.toBe(error);
    return pool.query(writes);
  }

  it("rolls back on an ECONNRESET that fn raised itself", async () => {
    const error = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    await expect(writesAfterRollback(error)).resolves.toMatchObject({ rows: [{ writes: 0 }] });
  });

  it("rolls back on a CONNECTION_CLOSED from another connection", async () => {
    const [foreign] = await Promise.all([
      db
        .ownPool()
        .session((session) => session.query(doomed))
        .catch((error: unknown) => error),
      terminateBackendRunning(db.driver, doomed),
    ]);
    expect(foreign).toMatchObject({ code: "CONNECTION_CLOSED" });
    await expect(writesAfterRollback(foreign)).resolves.toMatchObject({ rows: [{ writes: 0 }] });
  });
});
