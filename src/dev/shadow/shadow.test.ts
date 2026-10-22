import { describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import type { Driver } from "../../runtime/ports/index.ts";
import { sweepStaleDatabases, withShadowDatabases, type OnInterrupt } from "./shadow.ts";

const db = useTestDatabase();

// Other test files may hold their own Shadow databases on the same server at the same time.
async function databaseExists(name: string): Promise<boolean> {
  const { rows } = await db.driver.query("select from pg_database where datname = $1", [name]);
  return rows.length === 1;
}

async function currentDatabase(driver: Driver): Promise<string> {
  const {
    rows: [row],
  } = await driver.query("select current_database() as name");
  return String(row?.["name"]);
}

describe("withShadowDatabases", () => {
  it("creates uniquely named Shadow and Definition databases, then drops both", async () => {
    const start = Math.floor(Date.now() / 1000);
    const names = await withShadowDatabases(db.driver, db.connect, async (databases) => {
      const shadow = await currentDatabase(databases.shadow);
      const definition = await currentDatabase(databases.definition);
      expect(await databaseExists(shadow)).toBe(true);
      expect(await databaseExists(definition)).toBe(true);
      return { shadow, definition };
    });

    expect(names.shadow).toMatch(/^smonn_db_shadow_\d+_[0-9a-f]{8}$/u);
    expect(names.definition).toMatch(/^smonn_db_definition_\d+_[0-9a-f]{8}$/u);
    const seconds = Number(/_(\d+)_/u.exec(names.shadow)?.[1]);
    expect(seconds).toBeGreaterThanOrEqual(start);
    expect(seconds).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    expect(await databaseExists(names.shadow)).toBe(false);
    expect(await databaseExists(names.definition)).toBe(false);
  });

  it("drops both databases when the callback throws", async () => {
    const names: string[] = [];
    await expect(
      withShadowDatabases(db.driver, db.connect, async ({ shadow, definition }) => {
        names.push(await currentDatabase(shadow), await currentDatabase(definition));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(names).toHaveLength(2);
    expect(await Promise.all(names.map((name) => databaseExists(name)))).toStrictEqual([
      false,
      false,
    ]);
  });

  it("drops both databases when interrupted, and unregisters its cleanups when done", async () => {
    const cleanups = new Set<() => Promise<void>>();
    const onInterrupt: OnInterrupt = (cleanup) => {
      cleanups.add(cleanup);
      return () => {
        cleanups.delete(cleanup);
      };
    };

    const names = await withShadowDatabases(
      db.driver,
      db.connect,
      async ({ shadow, definition }) => {
        const both = [await currentDatabase(shadow), await currentDatabase(definition)];
        expect(cleanups.size).toBe(2);
        await Promise.all([...cleanups].map((cleanup) => cleanup()));
        return both;
      },
      { onInterrupt },
    );

    expect(await Promise.all(names.map((name) => databaseExists(name)))).toStrictEqual([
      false,
      false,
    ]);
    expect(cleanups.size).toBe(0);
  });

  it("refuses a role without CREATEDB, naming the privilege", async () => {
    const role = `smonn_db_test_${crypto.randomUUID().replaceAll("-", "")}`;
    await db.driver.execute(`create role ${role} nocreatedb`);
    try {
      await db.driver.session(async (session) => {
        await session.execute(`set role ${role}`);
        const driver: Driver = { ...session, session: (fn) => fn(session) };

        await expect(withShadowDatabases(driver, db.connect, async () => {})).rejects.toThrow(
          `generate creates its Shadow database, so role "${role}" needs CREATEDB`,
        );
      });
    } finally {
      await db.driver.execute(`drop role ${role}`);
    }
  });

  it("sweeps stale Shadow and Definition databases before it creates its own", async () => {
    const hoursAgo = Math.floor(Date.now() / 1000) - 7200;
    const stale = [
      `smonn_db_shadow_${hoursAgo}_deadbeef`,
      `smonn_db_definition_${hoursAgo}_deadbeef`,
    ];
    await Promise.all(
      stale.map((name) => db.driver.execute(`create database ${name} template template0`)),
    );

    await withShadowDatabases(db.driver, db.connect, async () => {});

    expect(await Promise.all(stale.map((name) => databaseExists(name)))).toStrictEqual([
      false,
      false,
    ]);
  });
});

describe("sweepStaleDatabases", () => {
  // Its own prefix, since the generate tests in other files sweep the real ones concurrently.
  const prefix = `smonn_db_sweep_${crypto.randomUUID().slice(0, 8)}_`;
  const now = Math.floor(Date.now() / 1000);

  it("drops idle databases older than an hour, logging each name", async () => {
    const stale = `${prefix}${now - 3601}_00000000`;
    const fresh = `${prefix}${now - 60}_11111111`;
    const busy = `${prefix}${now - 3601}_22222222`;
    const unnamed = `${prefix}${now - 3601}_backup`;
    await Promise.all(
      [stale, fresh, busy, unnamed].map((name) =>
        db.driver.execute(`create database ${name} template template0`),
      ),
    );
    const session = await db.connect(busy);
    const logged: string[] = [];
    try {
      await session.driver.query("select 1");

      await sweepStaleDatabases(db.driver, [prefix], (line) => {
        logged.push(line);
      });

      expect(logged).toStrictEqual([`dropped stale database "${stale}"`]);
      expect(await databaseExists(stale)).toBe(false);
      expect(await databaseExists(fresh)).toBe(true);
      expect(await databaseExists(busy)).toBe(true);
      expect(await databaseExists(unnamed)).toBe(true);
    } finally {
      await session.close();
      await Promise.all(
        [fresh, busy, unnamed].map((name) =>
          db.driver.execute(`drop database if exists ${name} with (force)`),
        ),
      );
    }
  });

  it("leaves a stale database the role can't drop", async () => {
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const sweeper = `smonn_db_sweeper_${suffix}`;
    const owner = `smonn_db_owner_${suffix}`;
    const theirs = `${prefix}${now - 3601}_33333333`;
    await db.driver.execute(`create role ${sweeper} createdb; create role ${owner};`);
    await db.driver.execute(`create database ${theirs} owner ${owner} template template0`);
    try {
      await db.driver.session(async (session) => {
        await session.execute(`set role ${sweeper}`);
        const driver: Driver = { ...session, session: (fn) => fn(session) };

        await sweepStaleDatabases(driver, [prefix], () => {});
      });

      expect(await databaseExists(theirs)).toBe(true);
    } finally {
      await db.driver.execute(`drop database if exists ${theirs} with (force)`);
      await db.driver.execute(`drop role ${sweeper}; drop role ${owner};`);
    }
  });
});
