import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { DEFAULT_TRACKING_SCHEMA, trackingSchema } from "../../runtime/internal/index.ts";
import type { Driver, Queryable } from "../../runtime/ports/index.ts";
import type { Rename } from "../catalog/index.ts";
import { renameInShadow, withRenames } from "./shadow-renames.ts";

const db = useTestDatabase();
const tracking = trackingSchema(DEFAULT_TRACKING_SCHEMA);

beforeEach(async () => {
  await db.driver.execute(`
    drop schema if exists smonn_db cascade; drop schema public cascade; create schema public;
    create table public.users (id integer);
    create table public.orders (id integer);`);
});

const renames: Rename[] = [
  { kind: "table", schema: "public", name: "people", was: "users" },
  { kind: "table", schema: "public", name: "sales", was: "orders" },
];

const failedRead = (_tx: Queryable): Promise<string> => Promise.reject(new Error("read failed"));

/** Counts the transactions a driver opens, passing them through. */
function counting(driver: Driver): { driver: Driver; opened: () => number } {
  let opened = 0;
  return {
    driver: {
      ...driver,
      transaction: (fn) => {
        opened += 1;
        return driver.transaction(fn);
      },
    },
    opened: () => opened,
  };
}

describe("renameInShadow", () => {
  it("reads the catalog under the new names and rolls the renames back", async () => {
    const result = await renameInShadow(db.driver, renames, tracking);

    expect(result.renames).toStrictEqual(renames);
    expect([...result.catalog.values()].filter((fact) => fact.kind === "table")).toStrictEqual([
      expect.objectContaining({ name: "people" }),
      expect.objectContaining({ name: "sales" }),
    ]);
    const { rows } = await db.driver.query(
      "select table_name from information_schema.tables where table_schema = 'public' order by 1",
    );
    expect(rows).toStrictEqual([{ table_name: "orders" }, { table_name: "users" }]);
  });

  it("opens no transaction of its own when no rename applies", async () => {
    const { driver, opened } = counting(db.driver);
    const missing: Rename = { kind: "table", schema: "public", name: "x", was: "nothing" };

    const result = await renameInShadow(driver, [missing], tracking);

    expect(result.renames).toStrictEqual([]);
    expect(opened()).toBe(1);
  });
});

describe("withRenames", () => {
  it("runs no script when there are no renames", async () => {
    const executed: string[] = [];
    const spy: Driver = {
      ...db.driver,
      transaction: (fn) =>
        db.driver.transaction((tx) =>
          fn({
            query: (text, params) => tx.query(text, params),
            execute: (script) => {
              executed.push(script);
              return tx.execute(script);
            },
          }),
        ),
    };

    expect(await withRenames(spy, [], () => Promise.resolve("read"))).toBe("read");
    expect(executed).toStrictEqual([]);
  });

  it("gives the error of a transaction that fails after the read", async () => {
    const failing: Driver = {
      ...db.driver,
      transaction: async (fn) => {
        await fn({
          query: () => Promise.reject(new Error("unused")),
          execute: () => Promise.resolve(),
        }).catch(() => {});
        throw new Error("rollback failed");
      },
    };

    await expect(withRenames(failing, [], () => Promise.resolve("read"))).rejects.toThrow(
      "rollback failed",
    );
  });

  it("gives the error of a read that fails", async () => {
    await expect(withRenames(db.driver, renames, failedRead)).rejects.toThrow("read failed");
  });
});
