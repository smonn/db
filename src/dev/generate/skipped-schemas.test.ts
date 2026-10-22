import { describe, expect, it } from "vitest";
import { defineDatabase, defineTable } from "../../runtime/definition/index.ts";
import type { Connect, Driver } from "../../runtime/ports/index.ts";
import { generate } from "./generate.ts";
import { memoryFileSystem } from "./memory-file-system.test-helper.ts";

const unreachable = (): Promise<never> => Promise.reject(new Error("touched the database"));
const driver: Driver = {
  query: unreachable,
  execute: unreachable,
  transaction: unreachable,
  session: unreachable,
};
const connect: Connect = unreachable;

describe("generate with a Definition schema that introspect skips", () => {
  it.each([
    ["smonn_db", "the tracking schema"],
    ["pg_audit", "a system schema"],
    ["information_schema", "a system schema"],
  ])("refuses schema %s, naming it", async (schema, reason) => {
    const fileSystem = memoryFileSystem();

    await expect(
      generate({
        driver,
        connect,
        fileSystem,
        definition: defineDatabase({
          [schema]: { audit: defineTable((c) => ({ id: c.text() })) },
        }),
        migrations: "db/migrations",
      }),
    ).rejects.toThrow(`the Definition names schema "${schema}", which generate skips as ${reason}`);
    expect(fileSystem.files.size).toBe(0);
  });

  it("refuses the configured tracking schema", async () => {
    await expect(
      generate({
        driver,
        connect,
        fileSystem: memoryFileSystem(),
        definition: defineDatabase({ AppTracking: {} }),
        migrations: "db/migrations",
        trackingSchema: "AppTracking",
      }),
    ).rejects.toThrow(
      `the Definition names schema "AppTracking", which generate skips as the tracking schema`,
    );
  });
});
