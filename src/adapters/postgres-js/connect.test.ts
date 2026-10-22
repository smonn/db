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

  it("reads ISO dates and hex bytea whatever the database's DateStyle and bytea_output", async () => {
    const name = `${db.name}_styles`;
    await db.driver.execute(`create database "${name}"`);
    await db.driver.execute(`
      alter database "${name}" set datestyle = 'SQL, DMY';
      alter database "${name}" set bytea_output = 'escape';
    `);
    try {
      const connection = await db.connect(name);
      try {
        const { rows } = await connection.driver.query(
          "select '2024-03-04'::date as date, '2024-03-04 05:06:07'::timestamp as timestamp, '\\x0102ff'::bytea as bytes",
        );
        expect(rows).toStrictEqual([
          {
            date: "2024-03-04",
            timestamp: new Date("2024-03-04T05:06:07Z"),
            bytes: new Uint8Array([1, 2, 255]),
          },
        ]);
      } finally {
        await connection.close();
      }
    } finally {
      await db.driver.execute(`drop database "${name}" with (force)`);
    }
  });
});
