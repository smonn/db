import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Driver, DriverRow, Queryable } from "../../runtime/ports/index.ts";
import { postgresJsConnect } from "./connect.ts";
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

async function backend(queryable: Queryable): Promise<DriverRow> {
  const { rows } = await queryable.query(
    "select pg_backend_pid() as pid, current_setting('search_path') as path",
  );
  return rows[0] ?? {};
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

describe("postgresJsDriver releasing a session to a one-connection pool", () => {
  const notices: unknown[] = [];
  let pool: { readonly driver: Driver; readonly close: () => Promise<void> };

  beforeAll(async () => {
    pool = await postgresJsConnect(String(process.env["DATABASE_URL"]), {
      max: 1,
      onnotice: (notice) => {
        notices.push(notice["message"]);
      },
    })(db.name);
  });
  afterAll(() => pool.close());
  beforeEach(() => {
    notices.length = 0;
  });

  it("resets settings, the role, and temp tables", async () => {
    await pool.driver.session((session) =>
      session.execute(
        "create temp table leaked (n int); set search_path = nowhere; set datestyle = 'SQL'; set role pg_monitor; set statement_timeout = '1ms'",
      ),
    );
    const { rows } = await pool.driver.query(
      "select current_user = session_user as own_role, current_setting('statement_timeout') as timeout, current_setting('search_path') as path, current_setting('DateStyle') like 'ISO,%' as iso, to_regclass('pg_temp.leaked') as temp",
    );
    expect(rows).toStrictEqual([
      { own_role: true, timeout: "0", path: '"$user", public', iso: true, temp: null },
    ]);
  });

  it("rejects with fn's error and rolls back a transaction fn leaves aborted", async () => {
    await pool.driver.execute("create table left_aborted (n int)");
    const failed = pool.driver.session(async (session) => {
      await session.execute("begin; insert into left_aborted values (1)");
      await session.query("select 1 / 0");
    });
    await expect(failed).rejects.toThrow("division by zero");
    expect((await pool.driver.query("select n from left_aborted")).rows).toStrictEqual([]);
  });

  it("rolls back a transaction fn leaves open", async () => {
    await pool.driver.execute("create table left_open (n int)");
    await pool.driver.session((session) =>
      session.execute("begin; insert into left_open values (1)"),
    );
    expect((await pool.driver.query("select n from left_open")).rows).toStrictEqual([]);
  });

  it("raises no notice when no transaction is open", async () => {
    await pool.driver.session((session) => session.query("select 1"));
    expect(notices).toStrictEqual([]);
  });

  it("keeps postgres.js's cached statements usable in the next transaction", async () => {
    const statement = "select $1::int as n";
    await pool.driver.session((session) => session.query(statement, [1]));
    const { rows } = await pool.driver.transaction((tx) => tx.query(statement, [2]));
    expect(rows).toStrictEqual([{ n: 2 }]);
  });
});

describe("postgresJsDriver when a session's reset fails", () => {
  let sql: Sql;
  let driver: Driver;
  // The driver's reset and close scripts start with a rollback; each is swapped for the next of these.
  let swaps: string[] = [];

  beforeAll(() => {
    const url = new URL(String(process.env["DATABASE_URL"]));
    url.pathname = `/${db.name}`;
    sql = postgres(url.href, {
      max: 1,
      onnotice: () => {},
      types: postgresJsTypes,
      connection: postgresJsConnection,
    });
    const reserve = sql.reserve.bind(sql);
    vi.spyOn(sql, "reserve").mockImplementation(async () => {
      const reserved = await reserve();
      const unsafe = reserved.unsafe.bind(reserved);
      vi.spyOn(reserved, "unsafe").mockImplementation((text, ...rest) =>
        unsafe(text.includes("rollback") ? (swaps.shift() ?? text) : text, ...rest),
      );
      return reserved;
    });
    driver = postgresJsDriver(sql);
  });
  afterAll(() => sql.end());
  beforeEach(() => {
    swaps = [];
  });

  it("closes the connection instead of returning it to the pool", async () => {
    swaps = ["select 1 / 0"];
    const inside = await driver.session(async (session) => {
      await session.execute("set search_path = nowhere");
      return backend(session);
    });
    const after = await backend(driver);
    expect(after).not.toStrictEqual(inside);
    expect(after).toMatchObject({ path: '"$user", public' });
  });

  it("retries a reset that a statement timeout cancels", async () => {
    swaps = ["set statement_timeout = 1; select pg_sleep(1)"];
    const inside = await driver.session(async (session) => {
      await session.execute("set search_path = nowhere");
      return backend(session);
    });
    expect(await backend(driver)).toStrictEqual({ ...inside, path: '"$user", public' });
  });

  it("rejects with the reset's error when it can't close the connection either", async () => {
    swaps = ["select 1 / 0", "select 1 / 0"];
    const inside = driver.session((session) => backend(session));
    await expect(inside).rejects.toThrow("division by zero");
    expect(await backend(driver)).toMatchObject({ path: '"$user", public' });
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
