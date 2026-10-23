import { describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import type { Connect, Driver } from "../../runtime/ports/index.ts";
import { currentDatabase, databaseExistsOn } from "./shadow.test-helper.ts";
import { withShadowDatabases, type OnInterrupt } from "./shadow.ts";

const db = useTestDatabase();
const databaseExists = databaseExistsOn(db.driver);

function recordingInterrupts() {
  const cleanups = new Set<() => Promise<void>>();
  const onInterrupt: OnInterrupt = (cleanup) => {
    cleanups.add(cleanup);
    return () => {
      cleanups.delete(cleanup);
    };
  };
  return { cleanups, onInterrupt };
}

/**
 * A Driver whose create of a database named with `prefix` runs the registered cleanups while the
 * create is in flight, then records which databases a process killed right after them would
 * leave. `connect` waits for that record, so the run can't drop them itself first.
 */
function interruptDuringCreate(prefix: string) {
  const { cleanups, onInterrupt } = recordingInterrupts();
  const created: string[] = [];
  const leftAtExit: string[] = [];
  let recorded = Promise.resolve();
  const driver: Driver = {
    ...db.driver,
    execute: (sql) => {
      const name = /^create database "(smonn_db_\w+)"/u.exec(sql)?.[1];
      if (name === undefined) return db.driver.execute(sql);
      created.push(name);
      const creating = db.driver.execute(sql);
      if (name.startsWith(prefix)) {
        const running = [...cleanups].map((cleanup) => cleanup());
        recorded = Promise.allSettled([creating, ...running]).then(async () => {
          const exists = await Promise.all(created.map((n) => databaseExists(n)));
          leftAtExit.push(...created.filter((_, index) => exists[index] === true));
        });
      }
      return creating;
    },
  };
  const connect: Connect = async (name) => {
    await recorded;
    return db.connect(name);
  };
  return { driver, connect, onInterrupt, leftAtExit };
}

describe("withShadowDatabases interrupted", () => {
  it("drops both databases when interrupted, and unregisters its cleanups when done", async () => {
    const { cleanups, onInterrupt } = recordingInterrupts();

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

  it.each([
    { kind: "Shadow", prefix: "smonn_db_shadow_" },
    { kind: "Definition", prefix: "smonn_db_definition_" },
  ])(
    "leaves no database behind when interrupted during the $kind database's create",
    async ({ prefix }) => {
      const { driver, connect, onInterrupt, leftAtExit } = interruptDuringCreate(prefix);

      const run = withShadowDatabases(
        driver,
        connect,
        async ({ shadow, definition }) => {
          await currentDatabase(shadow);
          await currentDatabase(definition);
        },
        { onInterrupt },
      );

      await expect(run).rejects.toThrow(
        /^database (?:"smonn_db_\w+" does not exist|\d+ was concurrently dropped)$/u,
      );
      expect(leftAtExit).toStrictEqual([]);
    },
  );
});
