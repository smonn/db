import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { postgresJsDriver } from "./driver.ts";
import { useTestDatabase } from "./test-database.test-helper.ts";
import { postgresJsConnection, postgresJsTypes } from "./value-types.ts";

const db = useTestDatabase();

async function advisoryLocksHeld(key: number): Promise<unknown> {
  const {
    rows: [row],
  } = await db.driver.query(
    "select count(*)::int as held from pg_locks where locktype = 'advisory' and objid = $1",
    [key],
  );
  return row?.["held"];
}

describe("postgresJsDriver", () => {
  it("binds params in a query", async () => {
    const { rows } = await db.driver.query("select $1::int + $2::int as sum", [2, 3]);
    expect(rows).toStrictEqual([{ sum: 5 }]);
  });

  it("reports how many rows a statement changed or returned", async () => {
    await db.driver.execute("create table counted (n int)");
    const inserted = await db.driver.query("insert into counted values ($1), ($2)", [1, 2]);
    expect(inserted).toStrictEqual({ rows: [], count: 2 });
    const selected = await db.driver.query("select n from counted");
    expect(selected.count).toBe(2);
  });

  it("counts zero rows for a statement that has no row count", async () => {
    const created = await db.driver.query("create table ddl_count (n int)");
    expect(created).toStrictEqual({ rows: [], count: 0 });
    expect((await db.driver.query("truncate ddl_count")).count).toBe(0);
    expect((await db.driver.query("drop table ddl_count")).count).toBe(0);
  });

  it("prepares a query without params, so it refuses several statements", async () => {
    await expect(db.driver.query("select 1; select 2")).rejects.toThrow(
      "cannot insert multiple commands into a prepared statement",
    );
  });

  it("runs a script of several statements", async () => {
    await db.driver.execute("create table script (n int); insert into script values (1), (2);");
    const { rows } = await db.driver.query("select n from script order by n");
    expect(rows).toStrictEqual([{ n: 1 }, { n: 2 }]);
  });

  it("commits a transaction that resolves", async () => {
    await db.driver.execute("create table committed (n int)");
    const result = await db.driver.transaction(async (tx) => {
      await tx.execute("insert into committed values (1)");
      return "done";
    });
    expect(result).toBe("done");
    expect((await db.driver.query("select n from committed")).rows).toStrictEqual([{ n: 1 }]);
  });

  it("rolls back a transaction that rejects", async () => {
    await db.driver.execute("create table rolled_back (n int)");
    const failed = db.driver.transaction(async (tx) => {
      await tx.query("insert into rolled_back values ($1)", [1]);
      throw new Error("boom");
    });
    await expect(failed).rejects.toThrow("boom");
    expect((await db.driver.query("select n from rolled_back")).rows).toStrictEqual([]);
  });

  it("holds one connection for a session", async () => {
    const pids = await db.driver.session(async (session) => {
      const first = await session.query("select pg_backend_pid() as pid");
      await session.execute("select 1");
      const second = await session.query("select pg_backend_pid() as pid");
      return [first.rows, second.rows];
    });
    expect(pids[0]).toStrictEqual(pids[1]);
  });

  it("keeps a session advisory lock until the session ends", async () => {
    const lockedInside = await db.driver.session(async (session) => {
      await session.query("select pg_advisory_lock(56)");
      return db.driver.query("select pg_try_advisory_lock(56) as got");
    });
    expect(lockedInside.rows).toStrictEqual([{ got: false }]);
    expect(await advisoryLocksHeld(56)).toBe(0);
  });

  it("releases a session advisory lock when the session rejects", async () => {
    const failed = db.driver.session(async (session) => {
      await session.query("select pg_advisory_lock(57)");
      throw new Error("boom");
    });
    await expect(failed).rejects.toThrow("boom");
    expect(await advisoryLocksHeld(57)).toBe(0);
  });

  it("commits and rolls back transactions inside a session", async () => {
    await db.driver.execute("create table in_session (n int)");
    await db.driver.session(async (session) => {
      await session.transaction(async (tx) => {
        await tx.query("insert into in_session values ($1)", [1]);
      });
      const failed = session.transaction(async (tx) => {
        await tx.query("insert into in_session values ($1)", [2]);
        throw new Error("boom");
      });
      await expect(failed).rejects.toThrow("boom");
    });
    expect((await db.driver.query("select n from in_session")).rows).toStrictEqual([{ n: 1 }]);
  });
});

describe("postgresJsDriver without postgresJsTypes", () => {
  it("refuses a client created without them, naming the export", () => {
    const sql = postgres("postgres://localhost:1/none");
    expect(() => postgresJsDriver(sql)).toThrow("postgresJsTypes");
  });
});

describe("postgresJsDriver without postgresJsConnection", () => {
  const url = "postgres://localhost:1/none";
  const message =
    "postgresJsDriver needs a client created with postgres(url, { connection: postgresJsConnection }), which sets DateStyle=ISO and bytea_output=hex";

  it("refuses a client created without it, naming the export", () => {
    const sql = postgres(url, { types: postgresJsTypes });
    expect(() => postgresJsDriver(sql)).toThrow(message);
  });

  it("refuses a client whose URL sets another DateStyle", () => {
    const sql = postgres(`${url}?datestyle=SQL`, {
      types: postgresJsTypes,
      connection: postgresJsConnection,
    });
    expect(() => postgresJsDriver(sql)).toThrow(message);
  });

  it("refuses a client that sets another bytea_output", () => {
    const sql = postgres(url, {
      types: postgresJsTypes,
      connection: { ...postgresJsConnection, BYTEA_OUTPUT: "escape" },
    });
    expect(() => postgresJsDriver(sql)).toThrow(message);
  });

  it("accepts the settings in any case and with a date order", () => {
    const sql = postgres(url, {
      types: postgresJsTypes,
      connection: { datestyle: "iso, dmy", bytea_output: "HEX" },
    });
    expect(() => postgresJsDriver(sql)).not.toThrow();
  });
});
