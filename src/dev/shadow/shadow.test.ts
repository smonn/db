import { describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import type { Driver } from "../../runtime/ports/index.ts";
import { withShadowDatabases } from "./shadow.ts";

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
});
