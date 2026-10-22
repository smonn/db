import { describe, expect, it } from "vitest";
import { useTestDatabase } from "./test-database.test-helper.ts";

const db = useTestDatabase();

describe("postgresJsConnect", () => {
  it("opens a driver on the named database of the same server", async () => {
    const connection = await db.connect(db.name);
    try {
      const { rows } = await connection.driver.query("select current_database() as name");
      expect(rows).toStrictEqual([{ name: db.name }]);
    } finally {
      await connection.close();
    }
  });

  it("opens a database whose name a URL would need to escape", async () => {
    const name = `${db.name} a/b?c`;
    await db.driver.execute(`create database "${name}"`);
    try {
      const connection = await db.connect(name);
      try {
        const { rows } = await connection.driver.query("select current_database() as name");
        expect(rows).toStrictEqual([{ name }]);
      } finally {
        await connection.close();
      }
    } finally {
      await db.driver.execute(`drop database "${name}" with (force)`);
    }
  });
});
